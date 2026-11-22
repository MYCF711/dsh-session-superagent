import assert from 'node:assert/strict'
import test from 'node:test'

import { create, assign, wait, end, resume, history } from '../lib/rooms/ticket-state.js'

const T0 = '2026-11-21T12:00:00.000Z'
const T1 = '2026-11-21T12:01:00.000Z'
const T2 = '2026-11-21T12:02:00.000Z'
const T3 = '2026-11-21T12:03:00.000Z'
const T4 = '2026-11-21T12:04:00.000Z'
const THREAD = 'github:o/r#1'
const ASSIGNMENT = {
  sessionId: 'worker-session',
  workdir: 'D:/worktrees/issue-1',
  assignmentId: 'assign:ticket:github:o/r#1:1',
}

function openTicket(fields = {}) {
  return create({ threadKey: THREAD, at: T0, ...fields })
}

function assignedTicket(fields = {}) {
  return assign(openTicket(), { ...ASSIGNMENT, at: T1, ...fields })
}

test('Ticket：create 生成共享 DTO，默认派生 id，输入不被修改且输出深冻结', () => {
  const input = { threadKey: THREAD, at: T0 }
  const ticket = create(input)
  assert.deepEqual(ticket, {
    id: `ticket:${THREAD}`,
    threadKey: THREAD,
    status: 'open',
    ownerSessionId: null,
    workdir: null,
    assignmentId: null,
    resumeCount: 0,
    createdAt: T0,
    updatedAt: T0,
    endedAt: null,
    endReason: null,
    history: [{ at: T0, type: 'created', detail: '' }],
  })
  assert.deepEqual(input, { threadKey: THREAD, at: T0 })
  assert.equal(Object.isFrozen(ticket), true)
  assert.equal(Object.isFrozen(ticket.history), true)
  assert.equal(Object.isFrozen(ticket.history[0]), true)
  assert.throws(() => { ticket.status = 'ended' }, TypeError)
  assert.throws(() => ticket.history.push({}), TypeError)
  assert.equal(create({ id: 'custom', threadKey: THREAD, at: T0 }).id, 'custom')
})

test('Ticket：open→assigned 写入执行归属，旧快照和历史均不被原地修改', () => {
  const open = openTicket()
  const before = structuredClone(open)
  const assigned = assign(open, { ...ASSIGNMENT, at: T1, detail: 'claimed' })
  assert.notEqual(assigned, open)
  assert.deepEqual(open, before)
  assert.equal(assigned.status, 'assigned')
  assert.equal(assigned.ownerSessionId, ASSIGNMENT.sessionId)
  assert.equal(assigned.workdir, ASSIGNMENT.workdir)
  assert.equal(assigned.assignmentId, ASSIGNMENT.assignmentId)
  assert.equal(assigned.updatedAt, T1)
  assert.equal(assigned.createdAt, T0)
  assert.deepEqual(assigned.history.at(-1), { at: T1, type: 'assigned', detail: 'claimed' })
  assert.notEqual(assigned.history[0], open.history[0])
})

test('Ticket：assigned→waiting→ended 保留执行归属并记录结束原因', () => {
  const assigned = assignedTicket()
  const waiting = wait(assigned, { at: T2, detail: 'waiting for input' })
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.ownerSessionId, ASSIGNMENT.sessionId)
  assert.equal(waiting.assignmentId, ASSIGNMENT.assignmentId)
  const ended = end(waiting, { at: T3, reason: 'done' })
  assert.equal(ended.status, 'ended')
  assert.equal(ended.endedAt, T3)
  assert.equal(ended.updatedAt, T3)
  assert.equal(ended.endReason, 'done')
  assert.equal(ended.ownerSessionId, ASSIGNMENT.sessionId)
  assert.deepEqual(ended.history.map((event) => event.type), ['created', 'assigned', 'waiting', 'ended'])
  assert.equal(assigned.status, 'assigned')
  assert.equal(waiting.status, 'waiting')
})

test('Ticket：open 可以直接 end，waiting 可以重新 assign', () => {
  const cancelled = end(openTicket(), { at: T1, reason: 'cancelled' })
  assert.equal(cancelled.status, 'ended')
  assert.equal(cancelled.endReason, 'cancelled')

  const waiting = wait(assignedTicket(), { at: T2 })
  const reassigned = assign(waiting, {
    sessionId: 'worker-session-2', workdir: null, assignmentId: 'assign:second', at: T3,
  })
  assert.equal(reassigned.status, 'assigned')
  assert.equal(reassigned.ownerSessionId, 'worker-session-2')
  assert.equal(reassigned.assignmentId, 'assign:second')
  assert.equal(reassigned.workdir, null)
  assert.deepEqual(reassigned.history.map((event) => event.type), ['created', 'assigned', 'waiting', 'assigned'])
})

test('Ticket：只有显式人类 resume 能重开 ended，并清空归属、保留全部历史', () => {
  const ended = end(wait(assignedTicket(), { at: T2 }), { at: T3, reason: 'done' })
  assert.throws(() => resume(ended, { at: T4 }), /human/)
  assert.throws(() => resume(ended, { actor: 'system', at: T4 }), /human/)

  const resumed = resume(ended, { actor: 'human', at: T4, detail: 'continue manually' })
  assert.equal(resumed.status, 'open')
  assert.equal(resumed.ownerSessionId, null)
  assert.equal(resumed.workdir, null)
  assert.equal(resumed.assignmentId, null)
  assert.equal(resumed.endedAt, null)
  assert.equal(resumed.endReason, null)
  assert.equal(resumed.resumeCount, 1)
  assert.equal(resumed.createdAt, T0)
  assert.deepEqual(resumed.history.slice(0, -1), ended.history)
  assert.deepEqual(resumed.history.at(-1), { at: T4, type: 'resumed', detail: 'continue manually' })
  assert.equal(ended.status, 'ended')
  assert.equal(ended.history.length, 4)
  assert.throws(() => resume(resumed, { actor: 'human' }), /ended status/)
})

test('Ticket：非法迁移被拒绝，终态不能被 assign/wait 暗中复活', () => {
  const open = openTicket()
  assert.throws(() => wait(open, { at: T1 }), /assigned status/)
  const ended = end(assignedTicket(), { at: T2 })
  assert.throws(() => assign(ended, { ...ASSIGNMENT, at: T3 }), /human resume/)
  assert.throws(() => wait(ended, { at: T3 }), /assigned status/)
})

test('Ticket：eventId 重放不重复追加历史，旧事件晚到也不覆盖新状态', () => {
  const open = openTicket({ eventId: 'create-1' })
  const assigned = assign(open, { ...ASSIGNMENT, at: T1, eventId: 'assign-1' })
  const waiting = wait(assigned, { at: T2, eventId: 'wait-1' })
  const replayedAssign = assign(waiting, { ...ASSIGNMENT, at: T3, eventId: 'assign-1' })
  assert.equal(replayedAssign, waiting)
  assert.equal(replayedAssign.history.length, 3)
  assert.equal(wait(waiting, { at: T3, eventId: 'wait-1' }), waiting)
  assert.deepEqual(history(waiting).map((event) => event.eventId), ['create-1', 'assign-1', 'wait-1'])
  assert.throws(() => end(waiting, { at: T3, eventId: 'wait-1' }), /already consumed as waiting/)
})

test('Ticket：无 eventId 的同内容命令与重复 end 也幂等', () => {
  const assigned = assignedTicket()
  assert.equal(assign(assigned, { ...ASSIGNMENT, at: T2 }), assigned)
  const waiting = wait(assigned, { at: T2 })
  assert.equal(wait(waiting, { at: T3 }), waiting)
  const ended = end(waiting, { at: T3, reason: 'done' })
  assert.equal(end(ended, { at: T4, reason: 'different late attempt' }), ended)
  assert.equal(ended.history.length, 4)
  assert.equal(ended.updatedAt, T3)
})

test('Ticket：history 返回深冻结副本，调用方无法改写状态历史', () => {
  const ticket = assignedTicket()
  const view = history(ticket)
  assert.deepEqual(view, ticket.history)
  assert.notEqual(view, ticket.history)
  assert.notEqual(view[0], ticket.history[0])
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen(view[0]), true)
  assert.throws(() => { view[0].type = 'ended' }, TypeError)
  assert.equal(ticket.history[0].type, 'created')
})

test('Ticket：JSON 重启快照保留 eventId 幂等性，后续转换仍不改旧快照', () => {
  const assigned = assignedTicket({ eventId: 'assign-restart-1' })
  const restored = JSON.parse(JSON.stringify(assigned))
  const duplicate = assign(restored, { ...ASSIGNMENT, at: T2, eventId: 'assign-restart-1' })
  assert.deepEqual(duplicate, restored)
  assert.equal(Object.isFrozen(duplicate.history[0]), true)
  assert.equal(duplicate.history.length, 2)

  const waiting = wait(restored, { at: T2, eventId: 'wait-restart-1' })
  assert.equal(waiting.status, 'waiting')
  assert.equal(restored.status, 'assigned')
  assert.equal(restored.history.length, 2)
  assert.deepEqual(history(waiting).map((event) => event.eventId), [undefined, 'assign-restart-1', 'wait-restart-1'])
})

test('Ticket：缺省时间只取一次，结束状态、更新时间与历史事件一致', () => {
  const ended = end(openTicket(), { reason: 'done' })
  assert.equal(ended.endedAt, ended.updatedAt)
  assert.equal(ended.history.at(-1).at, ended.updatedAt)
  assert.equal(Number.isNaN(Date.parse(ended.updatedAt)), false)
})

test('Ticket：必要标识与恢复参数有明确校验', () => {
  assert.throws(() => create(), /threadKey/)
  assert.throws(() => create({ threadKey: THREAD, id: '' }), /id/)
  assert.throws(() => assign(openTicket(), { sessionId: 's' }), /assignmentId/)
  assert.throws(() => assign(openTicket(), { assignmentId: 'a' }), /sessionId/)
  assert.throws(() => history(null), /ticket/)
})
