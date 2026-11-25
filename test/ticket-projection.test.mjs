import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectRecords,
  projectExecution,
  projectDeployment,
  projectTicketRecord,
} from '../lib/rooms/ticket-projection.js'

const AT = '2026-11-21T12:00:00.000Z'

function ticket(id, status, fields = {}) {
  return {
    id,
    threadKey: `thread:${id}`,
    status,
    ownerSessionId: null,
    workdir: null,
    assignmentId: null,
    resumeCount: 0,
    createdAt: AT,
    updatedAt: AT,
    endedAt: null,
    endReason: null,
    history: [],
    ...fields,
  }
}

function fullState() {
  return {
    tickets: [
      ticket('t1', 'open'),
      ticket('t2', 'assigned', {
        ownerSessionId: 'session-a', workdir: '/work/t2', assignmentId: 'a2',
        history: [{ at: AT, type: 'assigned', detail: 'worker' }],
      }),
      ticket('t3', 'waiting'),
      ticket('t4', 'ended', { endedAt: AT, endReason: 'done', resumeCount: 2 }),
    ],
    subscriptions: [
      { threadKey: 'thread:t2', ticketId: 't2', sessionId: 'session-a', active: true, createdAt: AT },
      { threadKey: 'thread:t4', ticketId: 't4', sessionId: 'session-a', active: false, createdAt: AT },
    ],
    assignments: [
      { id: 'a1', ticketId: 't1', sessionId: 'session-old', workdir: '/work/t1', status: 'ended', attempts: 1 },
      { id: 'a2', ticketId: 't2', sessionId: 'session-a', workdir: '/work/t2', status: 'assigned', attempts: 2 },
    ],
    outbox: [
      { id: 'm1', ticketId: 't2', channel: { repo: 'o/r', number: 2 }, body: 'working', status: 'pending', attempts: 0, nextAt: AT, createdAt: AT, updatedAt: AT },
      { id: 'm2', ticketId: 't4', channel: {}, body: 'done', status: 'sent', attempts: 1, nextAt: AT, createdAt: AT, updatedAt: AT },
    ],
    currentTicketId: 't2',
    currentAssignmentId: 'a2',
    load: { maxWorkers: 2 },
    paused: false,
  }
}

test('records：统一投影 Ticket/订阅/Assignment/Outbox，冻结且不修改输入', () => {
  const state = fullState()
  const before = structuredClone(state)
  const view = projectRecords(state)

  assert.equal(view.total, 4)
  assert.deepEqual(view.counts, { open: 1, assigned: 1, waiting: 1, ended: 1 })
  assert.equal(view.records[1].id, 't2')
  assert.equal(view.records[1].historyCount, 1)
  assert.equal(view.records[3].resumeCount, 2)
  assert.equal(view.subscriptions.total, 2)
  assert.equal(view.subscriptions.active, 1)
  assert.equal(view.subscriptions.inactive, 1)
  assert.equal(view.assignments.total, 2)
  assert.deepEqual(view.assignments.counts, { assigned: 1, waiting: 0, ended: 1 })
  assert.equal(view.outbox.total, 2)
  assert.deepEqual(view.outbox.counts, { pending: 1, sending: 0, sent: 1, failed: 0, gone: 0 })

  assert.deepEqual(state, before, '投影不得修改输入')
  assert.deepEqual(projectRecords(state), view, '同一状态的重复投影一致')
  assert.notStrictEqual(view.records[1].history, state.tickets[1].history)
  assert.notStrictEqual(view.outbox.records[0].channel, state.outbox[0].channel)
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen(view.records), true)
  assert.equal(Object.isFrozen(view.records[1].history[0]), true)
  assert.equal(Object.isFrozen(view.subscriptions.records[0]), true)
  assert.equal(Object.isFrozen(view.outbox.records[0].channel), true)
  assert.throws(() => { view.records[0].status = 'ended' }, TypeError)

  state.tickets[1].history[0].detail = 'changed later'
  state.outbox[0].channel.repo = 'changed/later'
  assert.equal(view.records[1].history[0].detail, 'worker', '后续源状态变化不得穿透只读投影')
  assert.equal(view.outbox.records[0].channel.repo, 'o/r')
})

test('records：缺省集合为未知 null，显式空集合及其计数为 0', () => {
  const unknown = projectRecords({})
  assert.equal(unknown.records, null)
  assert.equal(unknown.total, null)
  assert.equal(unknown.counts.open, null)
  assert.equal(unknown.subscriptions.records, null)
  assert.equal(unknown.subscriptions.total, null)
  assert.equal(unknown.subscriptions.active, null)
  assert.equal(unknown.assignments.records, null)
  assert.equal(unknown.assignments.counts.assigned, null)
  assert.equal(unknown.outbox.records, null)
  assert.equal(unknown.outbox.counts.pending, null)

  const empty = projectRecords({ tickets: [], subscriptions: [], assignments: {}, outbox: [] })
  assert.deepEqual(empty.records, [])
  assert.equal(empty.total, 0)
  assert.ok(Object.values(empty.counts).every((count) => count === 0))
  assert.deepEqual(empty.subscriptions.records, [])
  assert.equal(empty.subscriptions.total, 0)
  assert.equal(empty.subscriptions.active, 0)
  assert.equal(empty.subscriptions.inactive, 0)
  assert.deepEqual(empty.assignments.records, [])
  assert.equal(empty.assignments.total, 0)
  assert.ok(Object.values(empty.assignments.counts).every((count) => count === 0))
  assert.deepEqual(empty.outbox.records, [])
  assert.equal(empty.outbox.total, 0)
  assert.ok(Object.values(empty.outbox.counts).every((count) => count === 0))
})

test('execution：定位当前 Ticket/Assignment，并汇总执行计数', () => {
  const state = fullState()
  const view = projectExecution(state)
  assert.equal(view.current.id, 't2')
  assert.equal(view.assignment.id, 'a2')
  assert.equal(view.total, 4)
  assert.equal(view.activeCount, 3)
  assert.equal(view.running, 1)
  assert.equal(view.queued, 1)
  assert.equal(view.maxWorkers, 2)
  assert.equal(view.paused, false)
  assert.equal(view.subscriptions.active, 1)
  assert.equal(view.outbox.counts.pending, 1)
  assert.equal(Object.isFrozen(view.assignment), true)
  assert.equal(Object.isFrozen(view.assignments.records), true)

  const overridden = projectExecution({ ...state, load: { running: 4, queued: 5, maxWorkers: 8 } })
  assert.equal(overridden.running, 4)
  assert.equal(overridden.queued, 5)
  assert.equal(overridden.maxWorkers, 8)
})

test('execution：不会把当前 Ticket 关联到另一个默认 Assignment', () => {
  const state = fullState()
  state.tickets[1].assignmentId = 'missing-assignment'
  delete state.currentAssignmentId
  const view = projectExecution(state)
  assert.equal(view.current.id, 't2')
  assert.equal(view.assignment, null)
})

test('records：兼容直接传 Ticket[] 时，不把同数组误作其他集合', () => {
  const view = projectRecords([ticket('t1', 'open')])
  assert.equal(view.total, 1)
  assert.equal(view.records[0].id, 't1')
  assert.equal(view.subscriptions.records, null)
  assert.equal(view.assignments.records, null)
  assert.equal(view.outbox.records, null)
})

test('execution：缺省不是空执行，显式空集合才是全部 0', () => {
  const unknown = projectExecution({})
  assert.equal(unknown.current, null)
  assert.equal(unknown.assignment, null)
  assert.equal(unknown.total, null)
  assert.equal(unknown.activeCount, null)
  assert.equal(unknown.running, null)
  assert.equal(unknown.queued, null)
  assert.equal(unknown.maxWorkers, null)
  assert.equal(unknown.paused, null)
  assert.equal(unknown.counts.assigned, null)

  const empty = projectExecution({ tickets: [], subscriptions: [], assignments: [], outbox: [] })
  assert.equal(empty.total, 0)
  assert.equal(empty.activeCount, 0)
  assert.equal(empty.running, 0)
  assert.equal(empty.queued, 0)
  assert.equal(empty.assignments.total, 0)
  assert.equal(empty.outbox.total, 0)
})

test('deployment：健康优先级、部署问题与嵌套值均为冻结只读摘要', () => {
  const state = {
    setup: { machine: { stateDir: '/state' } },
    health: {
      github: { state: 'ready', detail: 'ok', values: { repo: 'o/r' }, at: AT },
      worker: { state: 'starting', detail: 'boot' },
      delivery: { state: 'paused', detail: 'held' },
      outbox: { state: 'error', code: 'sendFailed', detail: 'failed' },
    },
  }
  const before = structuredClone(state)
  const view = projectDeployment(state)
  assert.equal(view.status, 'error')
  assert.equal(view.stateDir, '/state')
  assert.equal(view.problem, null)
  assert.equal(view.health.length, 4)
  assert.deepEqual(view.counts, { total: 4, ready: 1, error: 1, starting: 1, paused: 1, unknown: 0 })
  assert.equal(view.health[0].name, 'github')
  assert.equal(view.health[0].values.repo, 'o/r')
  assert.equal(Object.isFrozen(view.health[0].values), true)
  assert.deepEqual(state, before)

  const setupFailure = projectDeployment({ setup: { problem: { code: 'ghMissing', values: { bin: 'gh' } } } })
  assert.equal(setupFailure.status, 'error')
  assert.equal(setupFailure.health, null)
  assert.equal(setupFailure.counts.total, null)
  assert.equal(Object.isFrozen(setupFailure.problem.values), true)
})

test('deployment：未知健康与明确无健康项严格区分，未知项不伪装 ready', () => {
  const unknown = projectDeployment({})
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.health, null)
  assert.ok(Object.values(unknown.counts).every((count) => count === null))

  const empty = projectDeployment({ health: {} })
  assert.equal(empty.status, 'ready')
  assert.deepEqual(empty.health, [])
  assert.ok(Object.values(empty.counts).every((count) => count === 0))

  const incomplete = projectDeployment({ health: { legacy: { detail: 'no state yet' } } })
  assert.equal(incomplete.status, 'unknown')
  assert.equal(incomplete.counts.total, 1)
  assert.equal(incomplete.counts.unknown, 1)
  assert.equal(incomplete.counts.ready, 0)
})

test('单条 Ticket：history 缺省与空 history 的计数含义不同', () => {
  const unknown = projectTicketRecord(ticket('t', 'open', { history: undefined, resumeCount: undefined }))
  const empty = projectTicketRecord(ticket('t', 'open'))
  assert.equal(unknown.history, null)
  assert.equal(unknown.historyCount, null)
  assert.equal(unknown.resumeCount, null)
  assert.deepEqual(empty.history, [])
  assert.equal(empty.historyCount, 0)
  assert.equal(empty.resumeCount, 0)
})
