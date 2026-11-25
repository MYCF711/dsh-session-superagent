import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OutboxCasConflictError,
  createOutboxState,
} from '../lib/rooms/outbox.js'
import {
  createModularOutboxCommit,
  createModularOutboxHost,
} from '../lib/rooms/modular-outbox-host.js'

const T0 = '2026-11-21T12:00:00.000Z'
const later = (ms) => new Date(Date.parse(T0) + ms).toISOString()
const draft = (id, ticketId = 'ticket:a') => ({ id, ticketId, channel: { repo: 'o/r', number: 1 }, body: `body:${id}` })
const record = (id, fields = {}) => ({
  id,
  ticketId: 'ticket:a',
  channel: { repo: 'o/r', number: 1 },
  body: `body:${id}`,
  status: 'pending',
  attempts: 0,
  nextAt: T0,
  createdAt: T0,
  updatedAt: T0,
  ...fields,
})

function modularStore(initial = {}) {
  let current = { modularVersion: 0, outbox: [], ...initial }
  const calls = []
  return {
    calls,
    get current() { return current },
    replace(state) { current = state },
    async readState() { return current },
    async commitModularState(expectedVersion, mutate) {
      calls.push({ expectedVersion, mutate })
      if (current.modularVersion !== expectedVersion) {
        return {
          ...current,
          writeError: { code: 'MODULAR_CAS_CONFLICT', message: `modular state CAS conflict: expected ${expectedVersion}` },
        }
      }
      current = { ...mutate(current), modularVersion: expectedVersion + 1 }
      delete current.writeError
      return current
    },
  }
}

function hostFor(store, send = async () => ({ ok: true }), options = {}) {
  return createModularOutboxHost({
    readState: store.readState,
    commitModularState: store.commitModularState,
    send,
    ...options,
  })
}

test('modular-outbox-host commit 适配 true/{ok:true}/merged 与 false/{ok:false}/CAS 异常', async () => {
  const expected = createOutboxState({ revision: 4 })
  const next = createOutboxState({ revision: 5, outbox: [record('one')] })
  const successes = [true, { ok: true }, { modularVersion: 5 }]
  const conflicts = [false, { ok: false }, {
    modularVersion: 6,
    writeError: { code: 'MODULAR_CAS_CONFLICT', message: 'modular state CAS conflict' },
  }]

  for (const receipt of [...successes, ...conflicts]) {
    let expectedVersion = null
    const commit = createModularOutboxCommit({
      async commitModularState(version, mutate) {
        expectedVersion = version
        const merged = mutate({ modularVersion: 4, outbox: [], tickets: { kept: true } })
        assert.equal(merged.outbox[0].id, 'one')
        assert.deepEqual(merged.tickets, { kept: true })
        return receipt
      },
    })
    assert.equal(await commit(next, expected), successes.includes(receipt))
    assert.equal(expectedVersion, 4)
  }

  const thrownConflict = createModularOutboxCommit({
    async commitModularState() {
      const error = new Error('modular state CAS conflict')
      error.code = 'MODULAR_CAS_CONFLICT'
      throw error
    },
  })
  assert.equal(await thrownConflict(next, expected), false)

  const diskFailure = createModularOutboxCommit({
    async commitModularState() {
      return { modularVersion: 4, writeError: { message: 'disk full' } }
    },
  })
  await assert.rejects(() => diskFailure(next, expected), /disk full/)
})

test('modular-outbox-host CAS 冲突重读重试且有界，其他模块字段不被覆盖', async () => {
  const store = modularStore({ locale: 'zh' })
  const originalCommit = store.commitModularState
  let calls = 0
  store.commitModularState = async (expectedVersion, mutate) => {
    calls += 1
    if (calls <= 2) {
      store.replace({ ...store.current, modularVersion: store.current.modularVersion + 1, locale: calls === 1 ? 'en' : 'zh' })
      return {
        ...store.current,
        writeError: { code: 'MODULAR_CAS_CONFLICT', message: 'modular state CAS conflict' },
      }
    }
    return originalCommit(expectedVersion, mutate)
  }
  const host = hostFor(store)
  const added = await host.enqueue(draft('retried'), { at: T0 })
  assert.equal(added.status, 'enqueued')
  assert.equal(added.state.revision, 3)
  assert.equal(calls, 3)
  assert.equal(store.current.outbox[0].id, 'retried')
  assert.equal(store.current.locale, 'zh')

  let rejectedCalls = 0
  const rejecting = {
    async readState() { return { modularVersion: 0, outbox: [] } },
    async commitModularState() { rejectedCalls += 1; return { ok: false } },
  }
  const bounded = hostFor(rejecting, undefined, { maxCasRetries: 2 })
  await assert.rejects(
    () => bounded.enqueue(draft('never'), { at: T0 }),
    (error) => error instanceof OutboxCasConflictError && error.code === 'OUTBOX_CAS_CONFLICT',
  )
  assert.equal(rejectedCalls, 3, '首次尝试加两次重试后必须停止')
})

test('modular-outbox-host flush 失败退避保持 Ticket FIFO，其他 Ticket 可继续并保留发送回执', async () => {
  const store = modularStore()
  const sentCalls = []
  let firstA = true
  const host = hostFor(store, async (message) => {
    sentCalls.push(message.id)
    if (message.id === 'a1' && firstA) {
      firstA = false
      return undefined
    }
    return { ok: true, cursor: `post:${message.id}`, executor: { receipt: `executor:${message.id}` } }
  })
  await host.enqueue(draft('a1', 'ticket:a'), { at: T0 })
  await host.enqueue(draft('a2', 'ticket:a'), { at: T0 })
  await host.enqueue(draft('b1', 'ticket:b'), { at: T0 })

  const first = await host.flush({ at: T0, baseDelayMs: 1000 })
  assert.equal(first.status, 'failed')
  assert.equal(first.sent, 1)
  assert.equal(first.failed, 1)
  assert.deepEqual(sentCalls, ['a1', 'b1'], 'a1 退避挡住 a2，但不挡住 b1')
  assert.match(first.results[0].error, /not acknowledged/)
  assert.equal(first.results[1].receipt.cursor, 'post:b1')
  assert.equal(first.results[1].receipt.executor.receipt, 'executor:b1')
  assert.equal(first.nextAt, later(1000))
  let messages = (await host.read()).outbox
  assert.equal(messages.find((message) => message.id === 'a1').status, 'failed')
  assert.equal(messages.find((message) => message.id === 'a1').nextAt, later(1000))
  assert.equal(messages.find((message) => message.id === 'a2').status, 'pending')
  assert.equal(messages.find((message) => message.id === 'b1').status, 'sent')

  const second = await host.flush({ at: later(1000), baseDelayMs: 1000 })
  assert.equal(second.status, 'sent')
  assert.equal(second.sent, 2)
  assert.deepEqual(sentCalls, ['a1', 'b1', 'a1', 'a2'])
  messages = (await host.read()).outbox
  assert.equal(messages.find((message) => message.id === 'a1').attempts, 2)
  assert.ok(messages.every((message) => message.status === 'sent'))
})

test('modular-outbox-host 首次 flush recover→claim→send→settle，alreadySent 回执直接结算且不重写远端', async () => {
  const store = modularStore({
    modularVersion: 7,
    outbox: [record('remote-id', { status: 'sending', attempts: 1 })],
  })
  const remoteMarkers = new Set(['remote-id'])
  let externalWrites = 0
  let claimedAttempts = null
  const host = hostFor(store, async (message) => {
    claimedAttempts = message.attempts
    if (remoteMarkers.has(message.id)) return { alreadySent: true, remoteMarker: message.id }
    externalWrites += 1
    remoteMarkers.add(message.id)
    return { ok: true }
  })

  const flushed = await host.flush({ at: later(10) })
  assert.equal(flushed.recovery.status, 'recovered')
  assert.deepEqual(flushed.recoveredIds, ['remote-id'])
  assert.equal(claimedAttempts, 2)
  assert.equal(externalWrites, 0)
  assert.equal(flushed.sent, 1)
  assert.equal(flushed.alreadySent, 1)
  assert.equal(flushed.results[0].status, 'sent')
  assert.equal(flushed.results[0].alreadySent, true)
  assert.equal(flushed.results[0].receipt.remoteMarker, 'remote-id')
  const message = (await host.read()).outbox[0]
  assert.equal(message.status, 'sent')
  assert.equal(message.attempts, 2)
})

test('modular-outbox-host 迟到成功/失败回执都携带 attempts 栅栏，不覆盖新尝试', async (t) => {
  for (const outcome of ['success', 'failure']) {
    await t.test(outcome, async () => {
      const store = modularStore()
      const host = hostFor(store, async () => {
        const current = store.current.outbox[0]
        // 模拟另一执行者已 recover 并重新 claim，旧回执此时才返回。
        store.replace({
          ...store.current,
          modularVersion: store.current.modularVersion + 2,
          outbox: [{ ...current, status: 'sending', attempts: 2, nextAt: later(20), updatedAt: later(20) }],
        })
        if (outcome === 'failure') throw new Error('late failure')
        return { ok: true }
      })
      await host.enqueue(draft('fence'), { at: T0 })
      const flushed = await host.flush({ at: T0, baseDelayMs: 0 })
      assert.equal(flushed.stale, 1)
      assert.equal(flushed.sent, 0)
      assert.equal(flushed.failed, 0)
      assert.equal(flushed.results[0].status, 'stale')
      assert.equal(store.calls.length, 2, 'stale settle/retry 不得再 commit')
      const current = store.current.outbox[0]
      assert.equal(current.status, 'sending')
      assert.equal(current.attempts, 2)
    })
  }
})

test('modular-outbox-host 并发 flush 单飞，同一条消息只 claim/send 一次', async () => {
  const store = modularStore()
  let releaseSend
  let markCalled
  const called = new Promise((resolve) => { markCalled = resolve })
  const gate = new Promise((resolve) => { releaseSend = resolve })
  let sendCalls = 0
  const host = hostFor(store, async () => {
    sendCalls += 1
    markCalled()
    return gate
  })
  await host.enqueue(draft('single'), { at: T0 })

  const first = host.flush({ at: T0 })
  const second = host.flush({ at: T0 })
  assert.equal(first, second)
  await called
  releaseSend({ ok: true })
  const [left, right] = await Promise.all([first, second])
  assert.equal(left, right)
  assert.equal(sendCalls, 1)
  assert.equal(left.sent, 1)
  assert.equal((await host.read()).outbox[0].status, 'sent')
})

test('不同 Ticket 的 flush 排队执行，A 的回执不能冒充 B', async () => {
  const store = modularStore()
  const calls = []
  let release
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  const host = hostFor(store, async (message) => {
    calls.push(message.id)
    if (message.id === 'a') { startedResolve(); await blocked }
    return { ok: true }
  })
  await host.enqueue(draft('a', 'ticket:a'), { at: T0 })
  await host.enqueue(draft('b', 'ticket:b'), { at: T0 })
  const first = host.flush({ ticketId: 'ticket:a' })
  await started
  const second = host.flush({ ticketId: 'ticket:b' })
  let secondSettled = false
  second.then(() => { secondSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(secondSettled, false)
  assert.deepEqual(calls, ['a'])
  release()
  const [left, right] = await Promise.all([first, second])
  assert.deepEqual(left.results.map((result) => result.id), ['a'])
  assert.deepEqual(right.results.map((result) => result.id), ['b'])
  assert.equal(right.sent, 1)
})

test('跨进程 host：活跃租约不被 recover，双方不得重复外发', async () => {
  const store = modularStore()
  const calls = []
  let release
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  const send = async (message) => {
    calls.push(message.id)
    if (message.id === 'cross') { startedResolve(); await blocked }
    return { ok: true }
  }
  const firstHost = hostFor(store, send, { ownerId: 'process-a', leaseMs: 60_000 })
  const secondHost = hostFor(store, send, { ownerId: 'process-b', leaseMs: 60_000 })
  await firstHost.enqueue(draft('cross'), { at: T0 })
  const first = firstHost.flush({ at: T0 })
  await started
  const second = await secondHost.flush({ at: later(1000), recover: true })
  assert.deepEqual(calls, ['cross'])
  assert.equal(second.sent, 0)
  assert.equal(second.queueStatus, 'waiting')
  release()
  const settled = await first
  assert.equal(settled.sent, 1)
  assert.equal(calls.length, 1)
})

test('租约过期才允许另一进程恢复并继续发送', async () => {
  const store = modularStore({
    outbox: [record('expired', { status: 'sending', attempts: 1, leaseUntil: later(-1), ownerId: 'dead-process' })],
  })
  let sends = 0
  const host = hostFor(store, async () => { sends += 1; return { ok: true } }, { ownerId: 'process-b' })
  const report = await host.flush({ at: T0, recover: true })
  assert.equal(report.recovery.status, 'recovered')
  assert.equal(report.sent, 1)
  assert.equal(sends, 1)
  assert.equal(store.current.outbox[0].attempts, 2)
})
