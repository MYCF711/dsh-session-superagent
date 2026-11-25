import assert from 'node:assert/strict'
import test from 'node:test'

import {
  THREAD_SUBSCRIPTION_VERSION,
  createThreadSubscriptionState,
  subscribe,
  unsubscribe,
  syncTicketState,
  routeThreadEvent,
} from '../lib/rooms/thread-subscription.js'

const AT = '2026-11-21T12:00:00.000Z'
const THREAD = 'github:o/r#1'
const TICKET = 'ticket:github:o/r#1'
const SESSION = 'session-a'

function subscribed(spec = {}) {
  return subscribe(createThreadSubscriptionState(), {
    threadKey: THREAD,
    ticketId: TICKET,
    sessionId: SESSION,
    at: AT,
    ...spec,
  })
}

function event(id, fields = {}) {
  return { id, threadKey: THREAD, type: 'comment', actor: 'human', ...fields }
}

test('订阅房：subscribe 建立完整归属，重复订阅幂等且不修改输入', () => {
  const empty = createThreadSubscriptionState({ custom: 'keep' })
  const before = structuredClone(empty)
  const state = subscribe(empty, { threadKey: THREAD, ticketId: TICKET, sessionId: SESSION, at: AT })
  assert.equal(empty.custom, 'keep')
  assert.deepEqual(empty, before)
  assert.equal(state.threadSubscriptionVersion, THREAD_SUBSCRIPTION_VERSION)
  assert.deepEqual(state.subscriptions[THREAD], {
    threadKey: THREAD,
    ticketId: TICKET,
    sessionId: SESSION,
    active: true,
    createdAt: AT,
    ticketStatus: 'open',
    endReason: null,
  })
  assert.equal(subscribe(state, {
    threadKey: THREAD, ticketId: TICKET, sessionId: SESSION, at: '2026-11-22T00:00:00Z',
  }), state)
  assert.equal(state.subscriptions[THREAD].createdAt, AT)
})

test('订阅房：活跃 Thread 不得被另一 Ticket/session 静默抢绑', () => {
  const state = subscribed()
  assert.throws(() => subscribe(state, {
    threadKey: THREAD, ticketId: 'ticket:other', sessionId: SESSION,
  }), /unsubscribe before rebinding/)
  assert.throws(() => subscribe(state, {
    threadKey: THREAD, ticketId: TICKET, sessionId: 'session-b',
  }), /unsubscribe before rebinding/)
  assert.equal(state.subscriptions[THREAD].ticketId, TICKET)
  assert.equal(state.subscriptions[THREAD].sessionId, SESSION)
})

test('订阅房：unsubscribe 幂等保留历史归属，未订阅新事件只 eval', () => {
  const state = subscribed()
  const stopped = unsubscribe(state, THREAD)
  assert.notEqual(stopped, state)
  assert.equal(stopped.subscriptions[THREAD].active, false)
  assert.equal(stopped.subscriptions[THREAD].ticketId, TICKET)
  assert.equal(unsubscribe(stopped, THREAD), stopped)
  assert.equal(unsubscribe(stopped, 'github:o/r#missing'), stopped)

  const routed = routeThreadEvent(stopped, event('comment-1'))
  assert.equal(routed.disposition, 'eval')
  assert.equal(routed.reason, 'no-active-subscription')
  assert.equal(routed.ticketId, null)
  assert.equal(routed.sessionId, null)
  assert.equal(routed.duplicate, false)
})

test('订阅房：取消后可显式换绑，同 Ticket 重订保留 Ticket 状态', () => {
  let state = subscribed()
  state = syncTicketState(state, THREAD, { status: 'ended', endReason: 'completed' })
  state = unsubscribe(state, THREAD)
  const rebound = subscribe(state, {
    threadKey: THREAD, ticketId: TICKET, sessionId: 'session-b', at: '2026-11-22T01:00:00Z',
  })
  assert.equal(rebound.subscriptions[THREAD].sessionId, 'session-b')
  assert.equal(rebound.subscriptions[THREAD].ticketStatus, 'ended')
  assert.equal(rebound.subscriptions[THREAD].endReason, 'completed')
  assert.equal(rebound.subscriptions[THREAD].createdAt, '2026-11-22T01:00:00Z')

  const otherTicket = subscribe(unsubscribe(rebound, THREAD), {
    threadKey: THREAD, ticketId: 'ticket:github:o/r#2', sessionId: 'session-c', at: AT,
  })
  assert.equal(otherTicket.subscriptions[THREAD].ticketStatus, 'open')
  assert.equal(otherTicket.subscriptions[THREAD].endReason, null)
})

test('订阅房：syncTicketState 同步 ended/endReason，同值幂等且非 ended 清原因', () => {
  const open = subscribed()
  const waiting = syncTicketState(open, THREAD, { status: 'waiting', endReason: 'stale-reason' })
  assert.equal(waiting.subscriptions[THREAD].ticketStatus, 'waiting')
  assert.equal(waiting.subscriptions[THREAD].endReason, null)
  const ended = syncTicketState(waiting, THREAD, { status: 'ended', endReason: 'human-stop' })
  assert.equal(ended.subscriptions[THREAD].ticketStatus, 'ended')
  assert.equal(ended.subscriptions[THREAD].endReason, 'human-stop')
  assert.equal(syncTicketState(ended, THREAD, { status: 'ended', endReason: 'human-stop' }), ended)
  const resumed = syncTicketState(ended, THREAD, { status: 'assigned' })
  assert.equal(resumed.subscriptions[THREAD].ticketStatus, 'assigned')
  assert.equal(resumed.subscriptions[THREAD].endReason, null)
  assert.equal(open.subscriptions[THREAD].ticketStatus, 'open', '历史快照不得被后续同步修改')
  assert.throws(() => syncTicketState(open, 'missing', { status: 'ended' }), /unknown thread/)
  assert.throws(() => syncTicketState(open, THREAD, {}), /status is required/)
  assert.throws(() => syncTicketState(open, THREAD, { status: 'deleted' }), /unsupported ticketStatus/)
})

test('订阅房：open/assigned/waiting 的后续事件 deliver 给原 Ticket/session', () => {
  for (const status of ['open', 'assigned', 'waiting']) {
    const state = syncTicketState(subscribed(), THREAD, { status })
    const routed = routeThreadEvent(state, event(`comment-${status}`))
    assert.equal(routed.disposition, 'deliver')
    assert.equal(routed.ticketId, TICKET)
    assert.equal(routed.sessionId, SESSION)
    assert.equal(routed.reason, 'subscribed-event')
    assert.equal(routed.duplicate, false)
  }
})

test('订阅房：非结束 Ticket 的显式 resume 标记仍只 deliver，不触发非法生命周期迁移', () => {
  for (const status of ['open', 'assigned', 'waiting']) {
    const state = syncTicketState(subscribed(), THREAD, { status })
    const routed = routeThreadEvent(state, event(`resume-${status}`, { type: 'resume' }))
    assert.equal(routed.disposition, 'deliver')
    assert.equal(routed.reason, 'subscribed-event')
    assert.equal(routed.ticketId, TICKET)
    assert.equal(routed.sessionId, SESSION)
    assert.equal(typeof routed.state, 'object')
  }
})

test('订阅房：非人或冲突来源的 resume 标记不会误唤醒非结束 Ticket', () => {
  const cases = [
    { actor: 'agent' },
    { actor: 'system' },
    { actor: 'bot' },
    { actor: 'agent', human: true },
    { actor: 'human', human: false },
    {},
  ]
  for (const [index, fields] of cases.entries()) {
    const routed = routeThreadEvent(subscribed(), event(`non-human-${index}`, {
      type: 'resume', actor: undefined, ...fields,
    }))
    assert.equal(routed.disposition, 'deliver', JSON.stringify(fields))
    assert.notEqual(routed.reason, 'explicit-human-resume')
  }
})

test('订阅房：ended 普通人类 comment 在非 human-stop 时 resume', () => {
  const state = syncTicketState(subscribed(), THREAD, { status: 'ended', endReason: 'completed' })
  const routed = routeThreadEvent(state, event('human-after-end'))
  assert.equal(routed.disposition, 'resume')
  assert.equal(routed.reason, 'ended-human-comment')
  assert.equal(routed.ticketId, TICKET)
  assert.equal(routed.sessionId, SESSION)
})

test('订阅房：human-stop 普通事件 ignore，显式人类 resume 才可解锁', () => {
  const state = syncTicketState(subscribed(), THREAD, { status: 'ended', endReason: 'human-stop' })
  const humanComment = routeThreadEvent(state, event('stopped-comment'))
  assert.equal(humanComment.disposition, 'ignore')
  assert.equal(humanComment.reason, 'human-stop')
  const agentComment = routeThreadEvent(humanComment.state, event('stopped-agent', { actor: 'agent' }))
  assert.equal(agentComment.disposition, 'ignore')
  assert.equal(agentComment.reason, 'human-stop')
  const explicit = routeThreadEvent(agentComment.state, event('explicit-unlock', {
    type: 'resume', actor: { type: 'human' },
  }))
  assert.equal(explicit.disposition, 'resume')
  assert.equal(explicit.reason, 'explicit-human-resume')
})

test('订阅房：ended 的非人普通事件 eval，不能 deliver 给已结束执行体', () => {
  const state = syncTicketState(subscribed(), THREAD, { status: 'ended', endReason: 'completed' })
  for (const [index, actor] of ['agent', 'system', undefined].entries()) {
    const routed = routeThreadEvent(state, event(`ended-agent-${index}`, { actor }))
    assert.equal(routed.disposition, 'eval')
    assert.equal(routed.reason, 'ended-non-human-event')
    assert.equal(routed.ticketId, TICKET, 'eval 仍携带线程归属，但不代表向 ended 执行体投递')
    assert.equal(routed.sessionId, SESSION)
  }
  const fakeResume = routeThreadEvent(state, event('ended-agent-resume', { type: 'resume', actor: 'agent' }))
  assert.equal(fakeResume.disposition, 'eval')
})

test('订阅房：未订阅时即使显式人类 resume 也没有可恢复归属，只 eval', () => {
  const routed = routeThreadEvent(createThreadSubscriptionState(), event('orphan-resume', { type: 'resume' }))
  assert.equal(routed.disposition, 'eval')
  assert.equal(routed.ticketId, null)
  assert.equal(routed.sessionId, null)
})

test('订阅房：重复 deliver/resume 事件均 ignore，状态引用不变', () => {
  for (const type of ['comment', 'resume']) {
    const initial = type === 'resume'
      ? syncTicketState(subscribed(), THREAD, { status: 'ended', endReason: 'completed' })
      : subscribed()
    const first = routeThreadEvent(initial, event(`duplicate-${type}`, { type }))
    const expected = type === 'resume' ? 'resume' : 'deliver'
    assert.equal(first.disposition, expected)
    const snapshot = structuredClone(first.state)
    const second = routeThreadEvent(first.state, event(`duplicate-${type}`, {
      type, actor: 'agent', body: 'changed payload is still the same event id',
    }))
    assert.equal(second.disposition, 'ignore')
    assert.equal(second.reason, 'duplicate-event')
    assert.equal(second.duplicate, true)
    assert.equal(second.state, first.state)
    assert.equal(second.ticketId, TICKET)
    assert.deepEqual(first.state, snapshot)
    assert.equal(Object.keys(first.state.seenEvents).length, 1)
  }
})

test('订阅房：旧事件在取消和换绑后重投仍 ignore，不会投递给新主人', () => {
  const first = routeThreadEvent(subscribed(), event('old-event'))
  let state = unsubscribe(first.state, THREAD)
  state = subscribe(state, {
    threadKey: THREAD, ticketId: 'ticket:github:o/r#2', sessionId: 'session-new', at: AT,
  })
  const duplicate = routeThreadEvent(state, event('old-event'))
  assert.equal(duplicate.disposition, 'ignore')
  assert.equal(duplicate.ticketId, TICKET)
  assert.equal(duplicate.sessionId, SESSION)
  assert.equal(duplicate.state, state)
  const fresh = routeThreadEvent(duplicate.state, event('fresh-event'))
  assert.equal(fresh.disposition, 'deliver')
  assert.equal(fresh.ticketId, 'ticket:github:o/r#2')
  assert.equal(fresh.sessionId, 'session-new')
})

test('订阅房：event.id 按 Thread 隔离，数字与字符串 ID 归一去重', () => {
  const otherThread = 'github:o/r#2'
  let state = subscribe(subscribed(), {
    threadKey: otherThread, ticketId: 'ticket:github:o/r#2', sessionId: 'session-b', at: AT,
  })
  const first = routeThreadEvent(state, event(1001))
  state = first.state
  const other = routeThreadEvent(state, event(1001, {
    threadKey: otherThread, ticketId: 'ignored-payload-field',
  }))
  assert.equal(other.disposition, 'deliver')
  assert.equal(other.ticketId, 'ticket:github:o/r#2')
  const duplicate = routeThreadEvent(other.state, event('1001'))
  assert.equal(duplicate.disposition, 'ignore')
  assert.equal(duplicate.threadKey, THREAD)
  assert.equal(Object.keys(duplicate.state.seenEvents).length, 2)
})

test('订阅房：JSON 重启恢复后去重仍有效，新事件继续路由', () => {
  const first = routeThreadEvent(subscribed(), event('persisted-event'))
  const restored = createThreadSubscriptionState(JSON.parse(JSON.stringify(first.state)))
  assert.notEqual(restored, first.state)
  assert.notEqual(restored.subscriptions[THREAD], first.state.subscriptions[THREAD])
  const duplicate = routeThreadEvent(restored, event('persisted-event'))
  assert.equal(duplicate.disposition, 'ignore')
  assert.equal(duplicate.state, restored)
  const fresh = routeThreadEvent(duplicate.state, event('after-restart'))
  assert.equal(fresh.disposition, 'deliver')
  assert.equal(fresh.sessionId, SESSION)
})

test('订阅房：并行路由分支不修改共同快照，单写者串行提交保留两类事件', () => {
  const base = subscribed()
  const before = structuredClone(base)
  const left = routeThreadEvent(base, event('parallel-a'))
  const right = routeThreadEvent(base, event('parallel-b', { actor: 'agent' }))
  assert.deepEqual(base, before)
  assert.equal(left.state.seenEvents[Object.keys(right.state.seenEvents)[0]], undefined)
  assert.equal(right.state.seenEvents[Object.keys(left.state.seenEvents)[0]], undefined)

  const serial = routeThreadEvent(left.state, event('parallel-b', { actor: 'agent' }))
  assert.equal(serial.disposition, 'deliver')
  assert.equal(Object.keys(serial.state.seenEvents).length, 2)
  assert.equal(routeThreadEvent(serial.state, event('parallel-a')).disposition, 'ignore')
  assert.equal(routeThreadEvent(serial.state, event('parallel-b')).disposition, 'ignore')
})

test('订阅房：必需字段、非法状态和非法 Ticket 状态显式报错', () => {
  assert.throws(() => subscribe(createThreadSubscriptionState(), {}), /threadKey is required/)
  assert.throws(() => subscribe(createThreadSubscriptionState(), {
    threadKey: THREAD, ticketId: TICKET,
  }), /sessionId is required/)
  assert.throws(() => subscribed({ ticketStatus: 'closed' }), /unsupported ticketStatus/)
  assert.throws(() => subscribed({ ticketStatus: 'ended', endReason: '' }), /endReason is required/)
  assert.throws(() => routeThreadEvent(subscribed(), event('')), /event.id is required/)
  assert.throws(() => routeThreadEvent(subscribed(), { id: 'missing-thread' }), /event.threadKey is required/)
  assert.throws(() => routeThreadEvent(subscribed(), null), /event must be an object/)
  assert.throws(() => createThreadSubscriptionState({ threadSubscriptionVersion: 2 }), /newer than supported/)
})
