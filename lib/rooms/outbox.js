/**
 * 持久化 Outbox 房。
 *
 * 所有变更都先构造完整 next，再 await commit(next, expected)；commit 必须返回
 * true / { ok:true }，false / { ok:false } 表示 expected 已过期。房间不直接写宿主，
 * 也不调用外部 Channel。调用方在 claim 成功后发送，并带 returned attempts 结算，
 * 以防迟到回执覆盖下一次尝试。
 */
import { createHash } from 'node:crypto'

export const OUTBOX_VERSION = 1
const STATUSES = ['pending', 'sending', 'sent', 'failed', 'gone']
const STATUS_SET = new Set(STATUSES)
const TERMINAL = new Set(['sent', 'gone'])

export class OutboxCasConflictError extends Error {
  constructor(expected, next) {
    super(`outbox CAS conflict at revision ${expected.revision}`)
    this.name = 'OutboxCasConflictError'
    this.code = 'OUTBOX_CAS_CONFLICT'
    this.expectedRevision = expected.revision
    this.nextRevision = next.revision
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function eventAt(at) {
  return at === undefined ? new Date().toISOString() : requiredText(at, 'at')
}

function timeValue(value, name = 'at') {
  const parsed = Date.parse(requiredText(value, name))
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an ISO timestamp`)
  return parsed
}

function revision(value) {
  const number = value === undefined ? 0 : value
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('outbox revision must be a non-negative safe integer')
  return number
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function messageParts(message) {
  if (!isObject(message)) throw new TypeError('message must be an object')
  const ticketId = requiredText(message.ticketId, 'message.ticketId')
  if (!isObject(message.channel)) throw new TypeError('message.channel must be an object')
  if (typeof message.body !== 'string') throw new TypeError('message.body must be a string')
  return { ticketId, channel: clone(message.channel), body: message.body }
}

/** 内容寻址；channel 的键顺序不影响 ID。领域也可在 enqueue 时显式提供稳定 id。 */
export function outboxMessageId(message) {
  const { ticketId, channel, body } = messageParts(message)
  const digest = createHash('sha256').update(JSON.stringify(canonical([ticketId, channel, body]))).digest('hex')
  return `outbox:${digest.slice(0, 32)}`
}

function normalizeMessage(message) {
  const parts = messageParts(message)
  const normalized = {
    id: requiredText(message.id, 'message.id'),
    ...parts,
    status: requiredText(message.status, 'message.status'),
    attempts: message.attempts,
    nextAt: requiredText(message.nextAt, 'message.nextAt'),
    createdAt: requiredText(message.createdAt, 'message.createdAt'),
    updatedAt: requiredText(message.updatedAt, 'message.updatedAt'),
    ...(message.leaseUntil !== undefined ? { leaseUntil: message.leaseUntil } : {}),
    ...(message.ownerId !== undefined ? { ownerId: message.ownerId } : {}),
    ...(message.lastError !== undefined ? { lastError: message.lastError } : {}),
  }
  if (!STATUS_SET.has(normalized.status)) throw new TypeError(`unknown outbox status: ${normalized.status}`)
  if (!Number.isSafeInteger(normalized.attempts) || normalized.attempts < 0) {
    throw new TypeError('message.attempts must be a non-negative safe integer')
  }
  timeValue(normalized.nextAt, 'message.nextAt')
  if (normalized.leaseUntil !== undefined && normalized.leaseUntil !== null) timeValue(normalized.leaseUntil, 'message.leaseUntil')
  return normalized
}

/** 恢复 JSON 状态时保留队列顺序；重复持久 ID 属于损坏状态，直接拒绝。 */
export function createOutboxState(fields = {}) {
  if (!isObject(fields)) throw new TypeError('outbox state must be an object')
  if (fields.outbox !== undefined && !Array.isArray(fields.outbox)) throw new TypeError('outbox must be an array')
  const source = fields.outbox || []
  const outbox = source.map(normalizeMessage)
  const ids = new Set()
  for (const message of outbox) {
    if (ids.has(message.id)) throw new TypeError(`duplicate outbox id: ${message.id}`)
    ids.add(message.id)
  }
  return {
    ...fields,
    outboxVersion: OUTBOX_VERSION,
    revision: revision(fields.revision),
    outbox,
  }
}

function asState(input) {
  if (input === undefined || input === null) return createOutboxState()
  if (!isObject(input)) throw new TypeError('outbox state must be an object')
  if (input.outboxVersion !== undefined && input.outboxVersion !== OUTBOX_VERSION) {
    throw new Error(`outboxVersion ${input.outboxVersion} is newer than supported ${OUTBOX_VERSION}`)
  }
  if (input.outboxVersion === OUTBOX_VERSION && Array.isArray(input.outbox)) return input
  return createOutboxState(input)
}

async function persist(next, expected, commit) {
  if (typeof commit !== 'function') throw new TypeError('outbox mutation requires commit(next, expected)')
  const receipt = await commit(next, expected)
  if (receipt === false || (isObject(receipt) && receipt.ok === false)) throw new OutboxCasConflictError(expected, next)
  if (receipt !== true && !(isObject(receipt) && receipt.ok === true)) {
    throw new TypeError('commit must acknowledge true/{ok:true} or reject false/{ok:false}')
  }
  return next
}

function replace(state, id, changes) {
  return {
    ...state,
    outboxVersion: OUTBOX_VERSION,
    revision: revision(state.revision) + 1,
    outbox: state.outbox.map((message) => message.id === id ? { ...message, ...changes } : message),
  }
}

function findMessage(state, id) {
  const key = requiredText(id, 'id')
  const message = state.outbox.find((candidate) => candidate.id === key)
  if (!message) throw new RangeError(`unknown outbox id: ${key}`)
  return message
}

function stale(source, message) {
  return source.attempts !== undefined && source.attempts !== message.attempts
}

/** 首次入队才 commit；同 ID 永远保留第一条，sent/gone 也不会复活。 */
export async function enqueue({ state: input, message, commit, at } = {}) {
  const state = asState(input)
  const parts = messageParts(message)
  const id = message.id === undefined ? outboxMessageId(message) : requiredText(message.id, 'message.id')
  const existing = state.outbox.find((candidate) => candidate.id === id)
  if (existing) return { status: 'duplicate', state, message: existing, reused: true }
  const timestamp = eventAt(at)
  const record = {
    id,
    ...parts,
    status: 'pending',
    attempts: 0,
    nextAt: message.nextAt === undefined ? timestamp : requiredText(message.nextAt, 'message.nextAt'),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  timeValue(record.nextAt, 'message.nextAt')
  const next = { ...state, outboxVersion: OUTBOX_VERSION, revision: revision(state.revision) + 1, outbox: [...state.outbox, record] }
  await persist(next, state, commit)
  return { status: 'enqueued', state: next, message: record, reused: false }
}

function firstActiveByTicket(state, ticketId) {
  const heads = new Map()
  for (const message of state.outbox) {
    if (TERMINAL.has(message.status)) continue
    if (ticketId !== undefined && message.ticketId !== ticketId) continue
    if (!heads.has(message.ticketId)) heads.set(message.ticketId, message)
  }
  return heads
}

/**
 * 单条认领。每个 Ticket 只有队首可发；其 sending / 退避会挡住同 Ticket 后续，
 * 但不挡住其他 Ticket。成功认领后 attempts 已持久化加一，然后才允许外发。
 */
export async function claim({ state: input, commit, ticketId, at, leaseMs = 60_000, ownerId } = {}) {
  const state = asState(input)
  if (ticketId !== undefined) requiredText(ticketId, 'ticketId')
  const timestamp = eventAt(at)
  const now = timeValue(timestamp)
  const heads = firstActiveByTicket(state, ticketId)
  const candidate = state.outbox.find((message) => heads.get(message.ticketId) === message
    && (message.status === 'pending' || message.status === 'failed')
    && timeValue(message.nextAt, 'message.nextAt') <= now)
  if (!candidate) {
    const active = [...heads.values()]
    const scheduled = active.filter((message) => message.status === 'pending' || message.status === 'failed')
      .map((message) => timeValue(message.nextAt, 'message.nextAt'))
    return {
      status: active.length ? 'waiting' : 'empty',
      state,
      message: null,
      nextAt: scheduled.length ? new Date(Math.min(...scheduled)).toISOString() : null,
    }
  }
  const lease = Number(leaseMs)
  if (!Number.isFinite(lease) || lease <= 0) throw new TypeError('leaseMs must be a positive finite number')
  const next = replace(state, candidate.id, {
    status: 'sending',
    attempts: candidate.attempts + 1,
    nextAt: timestamp,
    updatedAt: timestamp,
    leaseUntil: new Date(now + lease).toISOString(),
    ownerId: ownerId === undefined ? null : String(ownerId),
  })
  await persist(next, state, commit)
  const message = next.outbox.find((record) => record.id === candidate.id)
  return { status: 'claimed', state: next, message, nextAt: null }
}

/** result=sent 只接受 sending；result=gone 也可直接撤销 pending/failed。终态重复结算不 commit。 */
export async function settle({ state: input, id, result = 'sent', commit, at, attempts } = {}) {
  const state = asState(input)
  if (result !== 'sent' && result !== 'gone') throw new TypeError('settle result must be sent or gone')
  const current = findMessage(state, id)
  if (TERMINAL.has(current.status)) {
    if (current.status !== result) throw new Error(`outbox message is already ${current.status}`)
    return { status: 'duplicate', state, message: current }
  }
  if (attempts !== undefined && attempts !== current.attempts) return { status: 'stale', state, message: current }
  if (result === 'sent' && current.status !== 'sending') throw new Error('sent settlement requires a sending message')
  const timestamp = eventAt(at)
  const next = replace(state, current.id, { status: result, updatedAt: timestamp, leaseUntil: null, ownerId: null, lastError: null })
  await persist(next, state, commit)
  return { status: result, state: next, message: next.outbox.find((message) => message.id === current.id) }
}

/** 外发失败：sending → failed，默认 5 秒起步、指数增长、5 分钟封顶。 */
export async function retry({
  state: input,
  id,
  commit,
  at,
  attempts,
  error,
  baseDelayMs = 5000,
  maxDelayMs = 300000,
} = {}) {
  const state = asState(input)
  const current = findMessage(state, id)
  if (TERMINAL.has(current.status)) throw new Error(`cannot retry a ${current.status} message`)
  if (attempts !== undefined && attempts !== current.attempts) return { status: 'stale', state, message: current }
  if (current.status === 'failed') return { status: 'duplicate', state, message: current }
  if (current.status !== 'sending') throw new Error('retry requires a sending message')
  const base = Number(baseDelayMs)
  const cap = Number(maxDelayMs)
  if (!Number.isFinite(base) || base < 0 || !Number.isFinite(cap) || cap < 0) {
    throw new TypeError('retry delays must be non-negative finite numbers')
  }
  const timestamp = eventAt(at)
  const delay = Math.min(cap, base * (2 ** Math.max(0, current.attempts - 1)))
  const nextAt = new Date(timeValue(timestamp) + delay).toISOString()
  const next = replace(state, current.id, { status: 'failed', nextAt, updatedAt: timestamp, leaseUntil: null, ownerId: null, lastError: String(error || 'send failed').slice(0, 1000) })
  await persist(next, state, commit)
  return { status: 'failed', state: next, message: next.outbox.find((message) => message.id === current.id) }
}

/** 启动时恢复崩溃留下的 sending；attempts 不加，sent/gone 与失败退避原样保留。 */
export async function recover({ state: input, commit, at } = {}) {
  const state = asState(input)
  const timestamp = eventAt(at)
  const now = timeValue(timestamp)
  const recoveredIds = state.outbox.filter((message) => message.status === 'sending'
    && (!message.leaseUntil || timeValue(message.leaseUntil, 'message.leaseUntil') <= now)).map((message) => message.id)
  if (!recoveredIds.length) return { status: 'unchanged', state, recoveredIds }
  const ids = new Set(recoveredIds)
  const next = {
    ...state,
    outboxVersion: OUTBOX_VERSION,
    revision: revision(state.revision) + 1,
    outbox: state.outbox.map((message) => ids.has(message.id)
      ? { ...message, status: 'pending', nextAt: timestamp, updatedAt: timestamp, leaseUntil: null, ownerId: null }
      : message),
  }
  await persist(next, state, commit)
  return { status: 'recovered', state: next, recoveredIds }
}

function projectedRecord(message) {
  return {
    id: typeof message.id === 'string' && message.id ? message.id : null,
    ticketId: typeof message.ticketId === 'string' && message.ticketId ? message.ticketId : null,
    channel: message.channel === undefined ? null : clone(message.channel),
    body: typeof message.body === 'string' ? message.body : null,
    status: STATUS_SET.has(message.status) ? message.status : null,
    attempts: Number.isSafeInteger(message.attempts) && message.attempts >= 0 ? message.attempts : null,
    nextAt: typeof message.nextAt === 'string' && message.nextAt ? message.nextAt : null,
    createdAt: typeof message.createdAt === 'string' && message.createdAt ? message.createdAt : null,
    updatedAt: typeof message.updatedAt === 'string' && message.updatedAt ? message.updatedAt : null,
    ...(message.lastError !== undefined && message.lastError !== null ? { lastError: String(message.lastError) } : {}),
  }
}

/** 与 records 投影同形；缺集合是 null，显式空集合才是 0，且返回值完全冻结。 */
export function projectOutbox(input) {
  let known = false
  let items = []
  if (Array.isArray(input)) { known = true; items = input }
  else if (isObject(input) && Array.isArray(input.outbox)) { known = true; items = input.outbox }
  else if (isObject(input) && isObject(input.outbox)) { known = true; items = Object.values(input.outbox) }
  if (!known) {
    return deepFreeze({ records: null, total: null, counts: Object.fromEntries(STATUSES.map((status) => [status, null])) })
  }
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]))
  const records = items.map((message) => {
    const record = projectedRecord(isObject(message) ? message : {})
    if (record.status) counts[record.status] += 1
    return record
  })
  return deepFreeze({ records, total: records.length, counts })
}
