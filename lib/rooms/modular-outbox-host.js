/**
 * Outbox 房与宿主模块化状态事务之间的适配层。
 *
 * 宿主以 modularVersion 做整份模块化状态的 CAS；Outbox 房只看到自己的数组与
 * revision。这里负责两种形状的互换、有限冲突重试，以及崩溃恢复后的发送闭环。
 * 网络副作用只能由注入的 send(message) 完成。
 */
import { randomUUID } from 'node:crypto'
import {
  OutboxCasConflictError,
  claim as claimOutbox,
  createOutboxState,
  enqueue as enqueueOutbox,
  recover as recoverOutbox,
  retry as retryOutbox,
  settle as settleOutbox,
} from './outbox.js'

const DEFAULT_MAX_CAS_RETRIES = 4
const DEFAULT_FLUSH_LIMIT = 100

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error, fallback = 'unknown error') {
  return String(error && error.message || error || fallback).slice(0, 240)
}

function modularVersionOf(state) {
  const version = state && state.modularVersion
  return Number.isSafeInteger(version) && version >= 0 ? version : 0
}

function expectedVersionOf(state) {
  if (state && Number.isSafeInteger(state.modularVersion) && state.modularVersion >= 0) {
    return state.modularVersion
  }
  if (state && Number.isSafeInteger(state.revision) && state.revision >= 0) return state.revision
  throw new TypeError('expected outbox state must contain a non-negative revision')
}

function outboxStateOf(root) {
  if (root !== undefined && root !== null && !isObject(root)) {
    throw new TypeError('modular state must be an object')
  }
  const source = root || {}
  const revision = modularVersionOf(source)
  if (source.outbox === undefined) return createOutboxState({ revision })
  if (Array.isArray(source.outbox)) return createOutboxState({ outbox: source.outbox, revision })
  if (isObject(source.outbox) && Array.isArray(source.outbox.outbox)) {
    return createOutboxState({ ...source.outbox, revision })
  }
  throw new TypeError('modular state outbox must be an array or an outbox state')
}

function mergeOutboxState(disk, next) {
  if (disk !== undefined && disk !== null && !isObject(disk)) {
    throw new TypeError('modular state mutator requires an object')
  }
  const root = disk || {}
  // 同时读取早期可能落盘的完整 Outbox 房形状；新写入默认只保存消息数组，
  // revision 由宿主 modularVersion 统一提供，避免两个版本号各自漂移。
  if (isObject(root.outbox) && Array.isArray(root.outbox.outbox)) {
    return {
      ...root,
      outbox: {
        ...root.outbox,
        outboxVersion: next.outboxVersion,
        revision: next.revision,
        outbox: next.outbox,
      },
    }
  }
  return { ...root, outbox: next.outbox }
}

function hasCasConflictEvidence(value) {
  if (!value) return false
  if (typeof value === 'string') return /MODULAR_CAS_CONFLICT|OUTBOX_CAS_CONFLICT|CAS conflict/i.test(value)
  if (!isObject(value)) return false
  if (value.code === 'MODULAR_CAS_CONFLICT' || value.code === 'OUTBOX_CAS_CONFLICT') return true
  return hasCasConflictEvidence(value.message)
    || hasCasConflictEvidence(value.error)
    || hasCasConflictEvidence(value.writeError)
}

function invalidCommitReceipt() {
  return new TypeError('commitModularState must acknowledge true/{ok:true}/next state or reject false/{ok:false}/CAS conflict')
}

function commitReceipt(receipt, expectedVersion) {
  if (receipt === true) return true
  if (receipt === false) return false
  if (!isObject(receipt)) throw invalidCommitReceipt()
  if (receipt.ok === true) return true
  if (receipt.ok === false) return false

  // 现有 writeState 成功时直接返回 merged，CAS 失败时把异常写进 writeError。
  // 显式 writeError 优先：冲突后的 actualVersion 可能恰好是 expected+1，不能误认成功。
  // 其他写盘异常也不能伪装成可重试冲突。
  if (hasCasConflictEvidence(receipt)) return false
  if (receipt.writeError) {
    const error = new Error(`modular outbox commit failed: ${errorText(receipt.writeError)}`)
    error.code = 'OUTBOX_MODULAR_COMMIT_FAILED'
    throw error
  }
  if (Number.isSafeInteger(receipt.modularVersion) && receipt.modularVersion === expectedVersion + 1) return true
  if (Number.isSafeInteger(receipt.modularVersion)) return false
  throw invalidCommitReceipt()
}

/** 把 commitModularState(expectedVersion, mutate) 适配成 Outbox 的 commit(next, expected)。 */
export function createModularOutboxCommit({ commitModularState } = {}) {
  if (typeof commitModularState !== 'function') {
    throw new TypeError('createModularOutboxCommit requires commitModularState')
  }
  return async function commit(next, expected) {
    const expectedVersion = expectedVersionOf(expected)
    let receipt
    try {
      receipt = await commitModularState(expectedVersion, (disk) => mergeOutboxState(disk, next))
    } catch (error) {
      if (hasCasConflictEvidence(error)) return false
      throw error
    }
    return commitReceipt(receipt, expectedVersion)
  }
}

function retryLimit(value) {
  const limit = value === undefined ? DEFAULT_MAX_CAS_RETRIES : value
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('maxCasRetries must be a non-negative safe integer')
  }
  return limit
}

function flushLimit(value) {
  const limit = value === undefined ? DEFAULT_FLUSH_LIMIT : value
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('flush limit must be a non-negative safe integer')
  }
  return limit
}

function sendSucceeded(receipt) {
  if (receipt === true) return true
  if (!isObject(receipt) || receipt.ok === false) return false
  return receipt.ok === true || receipt.alreadySent === true
}

/**
 * 单进程内串行 flush；首次 flush 自动 recover，显式 recover:true 可强制恢复。
 * CAS 重试只包住状态迁移，绝不把已成功的外发包含进重试块而盲目再发一次。
 */
export function createModularOutboxHost(options = {}) {
  const { readState, commitModularState, send } = options
  if (typeof readState !== 'function') throw new TypeError('createModularOutboxHost requires readState')
  if (typeof send !== 'function') throw new TypeError('createModularOutboxHost requires send')
  const commit = createModularOutboxCommit({ commitModularState })
  const defaultCasRetries = retryLimit(options.maxCasRetries)
  const ownerId = options.ownerId || randomUUID()
  const leaseMs = options.leaseMs === undefined ? 60_000 : Number(options.leaseMs)
  let recovered = false
  let activeFlush = null

  async function transact(operation, overrides = {}) {
    const maxRetries = retryLimit(overrides.maxCasRetries === undefined ? defaultCasRetries : overrides.maxCasRetries)
    let lastConflict = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const state = outboxStateOf(await readState())
      try {
        return await operation(state, commit)
      } catch (error) {
        if (!error || error.code !== 'OUTBOX_CAS_CONFLICT') throw error
        lastConflict = error
      }
    }
    throw lastConflict || new OutboxCasConflictError(createOutboxState(), createOutboxState({ revision: 1 }))
  }

  async function read() {
    return outboxStateOf(await readState())
  }

  async function enqueue(message, overrides = {}) {
    return transact((state, roomCommit) => enqueueOutbox({
      state, message, commit: roomCommit, at: overrides.at,
    }), overrides)
  }

  async function recover(overrides = {}) {
    const result = await transact((state, roomCommit) => recoverOutbox({
      state, commit: roomCommit, at: overrides.at,
    }), overrides)
    recovered = true
    return result
  }

  function summarize({ state, queueStatus, nextAt, recovery, results, limited = false }) {
    const sent = results.filter((result) => result.status === 'sent').length
    const failed = results.filter((result) => result.status === 'failed').length
    const stale = results.filter((result) => result.status === 'stale').length
    const alreadySent = results.filter((result) => result.status === 'sent' && result.alreadySent).length
    let status = queueStatus
    if (limited) status = 'limited'
    else if (results.length) status = failed ? 'failed' : sent ? 'sent' : 'stale'
    return {
      status,
      queueStatus,
      state,
      recovery,
      recoveredIds: recovery ? [...recovery.recoveredIds] : [],
      results,
      sent,
      failed,
      stale,
      alreadySent,
      nextAt,
    }
  }

  async function runFlush(overrides) {
    const at = overrides.at
    const limit = flushLimit(overrides.limit === undefined ? overrides.maxMessages : overrides.limit)
    const retryOptions = { maxCasRetries: overrides.maxCasRetries }
    let recovery = null
    if (overrides.recover === true || (overrides.recover !== false && !recovered)) {
      recovery = await recover({ at, maxCasRetries: overrides.maxCasRetries })
    }

    const results = []
    for (let index = 0; index < limit; index += 1) {
      const claimed = await transact((state, roomCommit) => claimOutbox({
        state, commit: roomCommit, ticketId: overrides.ticketId, at,
        ownerId, leaseMs: overrides.leaseMs === undefined ? leaseMs : overrides.leaseMs,
      }), retryOptions)
      if (claimed.status !== 'claimed') {
        return summarize({
          state: claimed.state,
          queueStatus: claimed.status,
          nextAt: claimed.nextAt,
          recovery,
          results,
        })
      }

      const message = claimed.message
      const base = { id: message.id, ticketId: message.ticketId, attempts: message.attempts }
      let receipt = null
      let failure = null
      try {
        receipt = await send(message)
        if (!sendSucceeded(receipt)) failure = errorText(receipt && receipt.error, 'send was not acknowledged')
      } catch (error) {
        failure = errorText(error)
      }

      if (failure === null) {
        const settled = await transact((state, roomCommit) => settleOutbox({
          state,
          id: message.id,
          result: 'sent',
          attempts: message.attempts,
          commit: roomCommit,
          at,
        }), retryOptions)
        results.push({
          ...base,
          status: settled.status === 'stale' ? 'stale' : 'sent',
          alreadySent: isObject(receipt) && receipt.alreadySent === true,
          receipt,
        })
      } else {
        const retried = await transact((state, roomCommit) => retryOutbox({
          state,
          id: message.id,
          attempts: message.attempts,
          commit: roomCommit,
          at,
          baseDelayMs: overrides.baseDelayMs === undefined ? options.baseDelayMs : overrides.baseDelayMs,
          maxDelayMs: overrides.maxDelayMs === undefined ? options.maxDelayMs : overrides.maxDelayMs,
          error: failure,
        }), retryOptions)
        results.push({
          ...base,
          status: retried.status === 'stale' ? 'stale' : 'failed',
          alreadySent: false,
          receipt,
          error: failure,
        })
      }
    }

    return summarize({
      state: await read(),
      queueStatus: null,
      nextAt: null,
      recovery,
      results,
      limited: true,
    })
  }

  function flush(overrides = {}) {
    const scope = overrides.ticketId === undefined ? '*' : String(overrides.ticketId)
    if (activeFlush) {
      if (activeFlush.scope === scope) return activeFlush.promise
      // 不同 scope 不能共享 A 的回执：等当前 recover/send 结束后，再跑自己的 flush。
      return activeFlush.promise.then(() => flush(overrides), () => flush(overrides))
    }
    const active = { scope, promise: null }
    active.promise = (async () => {
      try {
        return await runFlush(overrides)
      } finally {
        if (activeFlush === active) activeFlush = null
      }
    })()
    activeFlush = active
    return active.promise
  }

  return Object.freeze({ read, enqueue, recover, flush })
}
