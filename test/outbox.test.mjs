import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OutboxCasConflictError,
  claim,
  createOutboxState,
  enqueue,
  outboxMessageId,
  projectOutbox,
  recover,
  retry,
  settle,
} from '../lib/rooms/outbox.js'

const T0 = '2026-11-21T12:00:00.000Z'
const later = (ms) => new Date(Date.parse(T0) + ms).toISOString()
const draft = (id, ticketId = 'ticket:a') => ({ id, ticketId, channel: { repo: 'o/r', number: 1 }, body: `body:${id}` })

function store(initial = createOutboxState()) {
  let current = initial
  const calls = []
  return {
    get current() { return current },
    calls,
    reset(state) { current = state },
    async commit(next, expected) {
      calls.push({ next, expected })
      if (current !== expected) return false
      current = next
      return true
    },
  }
}

async function add(state, commit, message, at = T0) {
  const result = await enqueue({ state, message, commit, at })
  assert.equal(result.status, 'enqueued')
  return result.state
}

test('Outbox：内容 ID 确定且 channel 键序无关，重复入队保留首条且不 commit', async () => {
  const left = { ticketId: 'ticket:a', channel: { number: 1, repo: 'o/r' }, body: 'same' }
  const right = { ticketId: 'ticket:a', channel: { repo: 'o/r', number: 1 }, body: 'same' }
  assert.equal(outboxMessageId(left), outboxMessageId(right))
  assert.match(outboxMessageId(left), /^outbox:[a-f0-9]{32}$/)
  assert.notEqual(outboxMessageId(left), outboxMessageId({ ...left, body: 'different' }))

  const persistence = store()
  const original = draft('stable')
  const snapshot = structuredClone(original)
  const first = await enqueue({ state: persistence.current, message: original, commit: persistence.commit, at: T0 })
  assert.deepEqual(original, snapshot, '不得修改调用方消息')
  assert.deepEqual(first.message, {
    id: 'stable', ticketId: 'ticket:a', channel: { repo: 'o/r', number: 1 }, body: 'body:stable',
    status: 'pending', attempts: 0, nextAt: T0, createdAt: T0, updatedAt: T0,
  })
  const before = first.state
  const duplicate = await enqueue({
    state: before,
    message: { ...original, body: 'changed must not replace first' },
    commit: async () => { throw new Error('duplicate must not commit') },
    at: later(1),
  })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.reused, true)
  assert.equal(duplicate.state, before)
  assert.equal(duplicate.message.body, 'body:stable')
  assert.equal(persistence.calls.length, 1)
})

test('Outbox：同 Ticket 严格 FIFO，sending 队首不阻塞其他 Ticket', async () => {
  const persistence = store()
  let state = persistence.current
  state = await add(state, persistence.commit, draft('a1', 'ticket:a'))
  state = await add(state, persistence.commit, draft('a2', 'ticket:a'))
  state = await add(state, persistence.commit, draft('b1', 'ticket:b'))

  const a1 = await claim({ state, commit: persistence.commit, at: T0 })
  assert.equal(a1.message.id, 'a1')
  assert.equal(a1.message.attempts, 1)
  const b1 = await claim({ state: a1.state, commit: persistence.commit, at: T0 })
  assert.equal(b1.message.id, 'b1', 'a1 sending 应挡住 a2，而不是 b1')
  const b1Sent = await settle({ state: b1.state, id: 'b1', result: 'sent', attempts: 1, commit: persistence.commit, at: later(1) })
  const a1Sent = await settle({ state: b1Sent.state, id: 'a1', result: 'sent', attempts: 1, commit: persistence.commit, at: later(2) })
  const a2 = await claim({ state: a1Sent.state, commit: persistence.commit, at: later(3) })
  assert.equal(a2.message.id, 'a2')
})

test('Outbox：失败指数退避并封顶，未到期队首挡住同 Ticket 后续', async () => {
  const persistence = store()
  let state = persistence.current
  state = await add(state, persistence.commit, draft('a1', 'ticket:a'))
  state = await add(state, persistence.commit, draft('a2', 'ticket:a'))
  state = await add(state, persistence.commit, draft('b1', 'ticket:b'))

  const first = await claim({ state, commit: persistence.commit, at: T0 })
  const failed = await retry({
    state: first.state, id: 'a1', attempts: 1, commit: persistence.commit,
    at: T0, baseDelayMs: 1000, maxDelayMs: 1500,
  })
  assert.equal(failed.message.status, 'failed')
  assert.equal(failed.message.nextAt, later(1000))
  const other = await claim({ state: failed.state, commit: persistence.commit, at: later(999) })
  assert.equal(other.message.id, 'b1')
  const waiting = await claim({ state: other.state, commit: persistence.commit, at: later(999) })
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.message, null)
  assert.equal(waiting.nextAt, later(1000))

  const second = await claim({ state: other.state, commit: persistence.commit, at: later(1000) })
  assert.equal(second.message.id, 'a1')
  assert.equal(second.message.attempts, 2)
  const failedAgain = await retry({
    state: second.state, id: 'a1', attempts: 2, commit: persistence.commit,
    at: later(1000), baseDelayMs: 1000, maxDelayMs: 1500,
  })
  assert.equal(failedAgain.message.nextAt, later(2500))
  const commits = persistence.calls.length
  const duplicate = await retry({ state: failedAgain.state, id: 'a1', commit: persistence.commit, at: later(2000) })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.state, failedAgain.state)
  assert.equal(persistence.calls.length, commits)
})

test('Outbox：gone 是不可逆终态，可撤销未发消息并释放同 Ticket 队首', async () => {
  const persistence = store()
  let state = persistence.current
  state = await add(state, persistence.commit, draft('g1'))
  state = await add(state, persistence.commit, draft('g2'))
  const gone = await settle({ state, id: 'g1', result: 'gone', commit: persistence.commit, at: T0 })
  assert.equal(gone.message.status, 'gone')
  const next = await claim({ state: gone.state, commit: persistence.commit, at: T0 })
  assert.equal(next.message.id, 'g2')
  const sent = await settle({ state: next.state, id: 'g2', attempts: 1, commit: persistence.commit, at: later(1) })
  const commits = persistence.calls.length
  const duplicate = await settle({ state: sent.state, id: 'g2', result: 'sent', commit: persistence.commit })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.state, sent.state)
  assert.equal(persistence.calls.length, commits)
  await assert.rejects(() => settle({ state: sent.state, id: 'g2', result: 'gone', commit: persistence.commit }), /already sent/)
  await assert.rejects(() => retry({ state: sent.state, id: 'g2', commit: persistence.commit }), /cannot retry/)
  assert.equal((await claim({ state: sent.state, commit: persistence.commit, at: later(2) })).status, 'empty')
})

test('Outbox：所有变更走 CAS，冲突抛专用错误且旧状态不被改写', async () => {
  const persistence = store()
  const stale = persistence.current
  const first = await enqueue({ state: stale, message: draft('one'), commit: persistence.commit, at: T0 })
  assert.equal(persistence.calls[0].expected, stale)
  assert.equal(persistence.calls[0].next, first.state)
  assert.equal(first.state.revision, stale.revision + 1)
  assert.equal(stale.outbox.length, 0)

  await assert.rejects(
    () => enqueue({ state: stale, message: draft('two'), commit: persistence.commit, at: T0 }),
    (error) => error instanceof OutboxCasConflictError && error.code === 'OUTBOX_CAS_CONFLICT',
  )
  assert.deepEqual(persistence.current.outbox.map((message) => message.id), ['one'])
  assert.equal(persistence.current.revision, 1)
  await assert.rejects(
    () => enqueue({ state: createOutboxState(), message: draft('bad-ack'), commit: async () => undefined }),
    /commit must acknowledge/,
  )
})

test('Outbox：JSON 重启恢复 sending，平台按稳定 ID 查重时只外发一次', async () => {
  const firstProcess = store()
  let state = await add(firstProcess.current, firstProcess.commit, draft('remote-id'))
  state = await add(state, firstProcess.commit, draft('after-remote'))
  const claimed = await claim({ state, commit: firstProcess.commit, at: T0, leaseMs: 1 })
  assert.equal(claimed.message.id, 'remote-id')

  const remote = new Set()
  let externalWrites = 0
  const send = async (message) => {
    if (remote.has(message.id)) return { ok: true, reused: true }
    remote.add(message.id) // 模拟远端已成功，但本地尚未 settle 就崩溃。
    externalWrites += 1
    return { ok: true, reused: false }
  }
  await send(claimed.message)

  const persisted = JSON.parse(JSON.stringify(claimed.state))
  const secondProcess = store(createOutboxState(persisted))
  const restored = await recover({ state: secondProcess.current, commit: secondProcess.commit, at: later(10) })
  assert.equal(restored.status, 'recovered')
  assert.deepEqual(restored.recoveredIds, ['remote-id'])
  assert.equal(restored.state.outbox[0].status, 'pending')
  assert.equal(restored.state.outbox[0].attempts, 1, '恢复不得伪增一次外发尝试')
  assert.equal(restored.state.outbox[1].status, 'pending')

  const retried = await claim({ state: restored.state, commit: secondProcess.commit, at: later(11) })
  assert.equal(retried.message.attempts, 2)
  assert.equal((await send(retried.message)).reused, true)
  const sent = await settle({ state: retried.state, id: 'remote-id', attempts: 2, commit: secondProcess.commit, at: later(12) })
  const duplicate = await enqueue({ state: sent.state, message: draft('remote-id'), commit: secondProcess.commit })
  assert.equal(duplicate.status, 'duplicate')
  const following = await claim({ state: duplicate.state, commit: secondProcess.commit, at: later(13) })
  assert.equal(following.message.id, 'after-remote')
  assert.equal(externalWrites, 1)
})

test('Outbox：恢复保留 failed 退避，sent/gone 不变；无 sending 时不 commit', async () => {
  const persistence = store()
  let state = await add(persistence.current, persistence.commit, draft('failed'))
  state = await add(state, persistence.commit, draft('gone'))
  const sending = await claim({ state, commit: persistence.commit, at: T0 })
  const failed = await retry({ state: sending.state, id: 'failed', commit: persistence.commit, at: T0, baseDelayMs: 5000 })
  const gone = await settle({ state: failed.state, id: 'gone', result: 'gone', commit: persistence.commit, at: T0 })
  const restoredState = createOutboxState(JSON.parse(JSON.stringify(gone.state)))
  const restored = await recover({ state: restoredState, commit: async () => { throw new Error('must not commit') }, at: later(99999) })
  assert.equal(restored.status, 'unchanged')
  assert.equal(restored.state, restoredState)
  assert.equal(restored.state.outbox[0].nextAt, later(5000))
  assert.equal(restored.state.outbox[1].status, 'gone')
})

test('Outbox：迟到 settle/retry 由 attempts 栅栏拒绝，不覆盖新尝试', async () => {
  const persistence = store()
  const state = await add(persistence.current, persistence.commit, draft('fence'))
  const first = await claim({ state, commit: persistence.commit, at: T0, leaseMs: 1 })
  const recovered = await recover({ state: first.state, commit: persistence.commit, at: later(1) })
  const second = await claim({ state: recovered.state, commit: persistence.commit, at: later(2) })
  assert.equal(second.message.attempts, 2)
  const staleSent = await settle({ state: second.state, id: 'fence', attempts: 1, commit: persistence.commit })
  const staleRetry = await retry({ state: second.state, id: 'fence', attempts: 1, commit: persistence.commit })
  assert.equal(staleSent.status, 'stale')
  assert.equal(staleRetry.status, 'stale')
  assert.equal(staleSent.state, second.state)
  assert.equal(staleRetry.state, second.state)
  const sent = await settle({ state: second.state, id: 'fence', attempts: 2, commit: persistence.commit, at: later(3) })
  assert.equal(sent.message.status, 'sent')
})

test('Outbox：失败原因随 failed 持久化，settle 后清除', async () => {
  const persistence = store()
  const state = await add(persistence.current, persistence.commit, draft('error-detail'))
  const claimed = await claim({ state, commit: persistence.commit, at: T0 })
  const failed = await retry({ state: claimed.state, id: 'error-detail', commit: persistence.commit, at: T0, error: 'provider timed out' })
  assert.equal(failed.message.lastError, 'provider timed out')
  const restored = createOutboxState(JSON.parse(JSON.stringify(failed.state)))
  persistence.reset(restored)
  const retried = await claim({ state: restored, commit: persistence.commit, at: later(5000) })
  const sent = await settle({ state: retried.state, id: 'error-detail', commit: persistence.commit, at: later(5001) })
  assert.equal(sent.message.lastError, null)
})

test('Outbox：未知投影计数为 null，显式空集合为 0，记录深冻结且不复用引用', async () => {
  const unknown = projectOutbox()
  assert.equal(unknown.records, null)
  assert.equal(unknown.total, null)
  assert.deepEqual(unknown.counts, { pending: null, sending: null, sent: null, failed: null, gone: null })
  const empty = projectOutbox(createOutboxState())
  assert.deepEqual(empty.records, [])
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.counts, { pending: 0, sending: 0, sent: 0, failed: 0, gone: 0 })

  const initial = createOutboxState()
  const persistence = store(initial)
  const state = await add(initial, persistence.commit, draft('view'))
  const view = projectOutbox(state)
  assert.equal(view.total, 1)
  assert.equal(view.counts.pending, 1)
  assert.ok(Object.isFrozen(view))
  assert.ok(Object.isFrozen(view.records))
  assert.ok(Object.isFrozen(view.records[0].channel))
  assert.notEqual(view.records[0].channel, state.outbox[0].channel)
  assert.throws(() => { view.records[0].channel.repo = 'changed' }, TypeError)
  assert.equal(state.outbox[0].channel.repo, 'o/r')
})

test('Outbox：损坏恢复状态与非法迁移显式失败', async () => {
  const persistence = store()
  const state = await add(persistence.current, persistence.commit, draft('one'))
  assert.throws(() => createOutboxState({ outbox: [state.outbox[0], state.outbox[0]] }), /duplicate outbox id/)
  assert.throws(() => createOutboxState({ outbox: {} }), /outbox must be an array/)
  await assert.rejects(() => settle({ state, id: 'missing', commit: persistence.commit }), /unknown outbox id/)
  await assert.rejects(() => retry({ state, id: 'one', commit: persistence.commit }), /requires a sending message/)
  await assert.rejects(() => settle({ state, id: 'one', result: 'sent', commit: persistence.commit }), /requires a sending message/)
})
