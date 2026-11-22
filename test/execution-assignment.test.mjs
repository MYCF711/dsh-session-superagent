import assert from 'node:assert/strict'
import test from 'node:test'

import {
  create as createTicket,
  end as endTicket,
  resume as resumeTicket,
  wait as waitTicket,
} from '../lib/rooms/ticket-state.js'
import {
  assertAbsoluteWorkdir,
  assertExecutorPort,
  createAssignment,
  planAssignment,
  promptAssignment,
  retryAssignment,
  startAssignment,
  statusAssignment,
  stopAssignment,
  transitionAssignment,
} from '../lib/rooms/execution-assignment.js'

const AT = '2026-11-21T12:00:00.000Z'
const LATER = '2026-11-21T12:01:00.000Z'
const THREAD = 'github:o/r#1'
const TICKET_ID = `ticket:${THREAD}`
const SESSION = 'worker-session'
const WORKDIR = '/work/ticket-1'

function planned() {
  const ticket = createTicket({ threadKey: THREAD, at: AT })
  return planAssignment({ ticket, sessionId: SESSION, workdir: WORKDIR, at: AT })
}

function executorStub(overrides = {}) {
  const calls = []
  const executor = {
    async start(context) { calls.push({ method: 'start', context }); return { ok: true, id: 'start' } },
    async prompt(context) { calls.push({ method: 'prompt', context }); return { ok: true, id: 'prompt' } },
    async status(context) { calls.push({ method: 'status', context }); return { ok: true, status: 'waiting' } },
    async stop(context) { calls.push({ method: 'stop', context }); return { ok: true, id: 'stop' } },
    ...overrides,
  }
  return { executor, calls }
}

test('Assignment：首次规划创建确定 ID 的 DTO，并只经 ticket-state 绑定 Ticket', () => {
  const source = createTicket({ threadKey: THREAD, at: AT })
  const before = structuredClone(source)
  const out = planAssignment({ ticket: source, sessionId: SESSION, workdir: WORKDIR, at: AT })

  assert.equal(out.action, 'start')
  assert.deepEqual(out.assignment, {
    id: `assign:${TICKET_ID}:1`,
    ticketId: TICKET_ID,
    sessionId: SESSION,
    workdir: WORKDIR,
    status: 'assigned',
    attempts: 1,
  })
  assert.equal(out.ticket.status, 'assigned')
  assert.equal(out.ticket.ownerSessionId, SESSION)
  assert.equal(out.ticket.workdir, WORKDIR)
  assert.equal(out.ticket.assignmentId, out.assignment.id)
  assert.deepEqual(source, before, '输入 Ticket 不得被修改')
})

test('Assignment：POSIX、Windows 与 UNC 绝对路径可用，相对路径和空值明确拒绝', () => {
  for (const path of ['/work/a', 'C:\\work\\a', 'D:/work/a', '\\\\server\\share\\work']) {
    assert.equal(assertAbsoluteWorkdir(path), path)
  }
  for (const path of ['', 'relative/work', './work', '../work', 'C:relative', 'bad\0path', null, undefined]) {
    assert.throws(() => assertAbsoluteWorkdir(path), /workdir/)
  }
  assert.throws(() => createAssignment({ ticketId: TICKET_ID, sessionId: SESSION, workdir: 'relative' }), /absolute path/)
})

test('Assignment：复用活跃派工保持对象、attempts 与 Ticket，不产生第二条历史', () => {
  const first = planned()
  const out = planAssignment({
    ticket: first.ticket,
    assignment: first.assignment,
    sessionId: SESSION,
    workdir: WORKDIR,
    at: LATER,
  })
  assert.equal(out.action, 'reuse')
  assert.equal(out.assignment, first.assignment)
  assert.equal(out.ticket, first.ticket)
  assert.equal(out.assignment.attempts, 1)
  assert.equal(out.ticket.history.length, first.ticket.history.length)
})

test('Assignment：活跃派工不得暗中换 session/workdir，也不能绑定别的 Ticket', () => {
  const first = planned()
  assert.throws(() => planAssignment({
    ticket: first.ticket, assignment: first.assignment, sessionId: 'other-session', workdir: WORKDIR,
  }), /cannot change sessionId/)
  assert.throws(() => planAssignment({
    ticket: first.ticket, assignment: first.assignment, sessionId: SESSION, workdir: '/work/other',
  }), /cannot change workdir/)
  assert.throws(() => planAssignment({
    ticket: createTicket({ threadKey: 'github:o/r#2', at: AT }),
    assignment: first.assignment,
    sessionId: SESSION,
    workdir: WORKDIR,
  }), /must match ticket.id/)
})

test('Assignment：等待中的复用不激活；显式 retry 才增加 attempts 并恢复 assigned', () => {
  const first = planned()
  const waitingTicket = waitTicket(first.ticket, { at: LATER, detail: 'idle' })
  const waitingAssignment = transitionAssignment(first.assignment, 'waiting')

  const reused = planAssignment({ ticket: waitingTicket, assignment: waitingAssignment })
  assert.equal(reused.action, 'reuse')
  assert.equal(reused.ticket, waitingTicket)
  assert.equal(reused.assignment, waitingAssignment)
  assert.equal(reused.ticket.status, 'waiting')

  const retried = planAssignment({ ticket: waitingTicket, assignment: waitingAssignment, retry: true, at: LATER })
  assert.equal(retried.action, 'retry')
  assert.equal(retried.assignment.id, first.assignment.id)
  assert.equal(retried.assignment.status, 'assigned')
  assert.equal(retried.assignment.attempts, 2)
  assert.equal(retried.ticket.status, 'assigned')
  assert.equal(waitingAssignment.status, 'waiting')
  assert.equal(waitingAssignment.attempts, 1)
})

test('Assignment：ended 不可原地 retry；人工 resume 后生成下一 sequence 且 attempts 重置', () => {
  const first = planned()
  const endedAssignment = transitionAssignment(first.assignment, 'ended')
  assert.throws(() => retryAssignment(endedAssignment), /cannot be retried/)

  const endedTicket = endTicket(first.ticket, { at: LATER, reason: 'done' })
  assert.throws(() => planAssignment({
    ticket: endedTicket, assignment: endedAssignment, sessionId: SESSION, workdir: WORKDIR,
  }), /ended|resume/i)

  const reopened = resumeTicket(endedTicket, { actor: 'human', at: LATER })
  const next = planAssignment({
    ticket: reopened, assignment: endedAssignment, sessionId: SESSION, workdir: WORKDIR, at: LATER,
  })
  assert.equal(next.action, 'start')
  assert.equal(next.assignment.id, `assign:${TICKET_ID}:2`)
  assert.equal(next.assignment.attempts, 1)
  assert.equal(next.assignment.status, 'assigned')
  assert.equal(endedAssignment.status, 'ended')
})

test('Executor 端口：start/prompt/status/stop 任一缺失都明确失败，四种操作均无静默回退', async () => {
  const current = planned()
  const methods = ['start', 'prompt', 'status', 'stop']
  const operations = (executor) => ({
    start: () => startAssignment({ executor, ticket: current.ticket, assignment: current.assignment }),
    prompt: () => promptAssignment({ executor, ticket: current.ticket, assignment: current.assignment, prompt: 'continue' }),
    status: () => statusAssignment({ executor, ticket: current.ticket, assignment: current.assignment }),
    stop: () => stopAssignment({ executor, ticket: current.ticket, assignment: current.assignment }),
  })

  for (const missing of methods) {
    const { executor } = executorStub()
    delete executor[missing]
    assert.throws(() => assertExecutorPort(executor), new RegExp(`missing required method: ${missing}`))
    const byName = operations(executor)
    for (const [name, invoke] of Object.entries(byName)) {
      await assert.rejects(invoke, new RegExp(`missing required method: ${missing}`), `${name} 应检查 ${missing}`)
    }
  }
  await assert.rejects(operations(null).start, /executor port is required/)
})

test('Executor start：只调用注入端口并传 Ticket/Assignment，成功后保持同一派工', async () => {
  const current = planned()
  const { executor, calls } = executorStub()
  const out = await startAssignment({ executor, ticket: current.ticket, assignment: current.assignment })
  assert.equal(out.assignment, current.assignment)
  assert.equal(out.receipt.id, 'start')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'start')
  assert.equal(calls[0].context.ticket, current.ticket)
  assert.equal(calls[0].context.assignment, current.assignment)
})

test('Executor prompt：传递非空 prompt；ended 或空调用不会触达端口', async () => {
  const current = planned()
  const { executor, calls } = executorStub()
  const out = await promptAssignment({
    executor, ticket: current.ticket, assignment: current.assignment, prompt: 'continue with tests',
  })
  assert.equal(out.assignment, current.assignment)
  assert.equal(calls[0].context.prompt, 'continue with tests')
  await assert.rejects(promptAssignment({
    executor, ticket: current.ticket, assignment: current.assignment, prompt: '',
  }), /prompt/)
  await assert.rejects(promptAssignment({
    executor, ticket: current.ticket, assignment: transitionAssignment(current.assignment, 'ended'), prompt: 'x',
  }), /ended assignment/)
  assert.equal(calls.length, 1)
})

test('Executor status：校验回执并不变更新状态，相同状态复用对象，ended 不可被重开', async () => {
  const current = planned()
  const { executor, calls } = executorStub()
  const waiting = await statusAssignment({ executor, ticket: current.ticket, assignment: current.assignment })
  assert.equal(waiting.assignment.status, 'waiting')
  assert.equal(current.assignment.status, 'assigned')
  assert.equal(calls[0].context.assignment, current.assignment)

  const same = await statusAssignment({ executor, ticket: waiting.ticket, assignment: waiting.assignment })
  assert.equal(same.assignment, waiting.assignment)

  const endedPort = executorStub({ status: async () => 'ended' })
  const ended = await statusAssignment({ executor: endedPort.executor, ticket: current.ticket, assignment: current.assignment })
  assert.equal(ended.assignment.status, 'ended')
  const reopenPort = executorStub({ status: async () => ({ status: 'assigned' }) })
  await assert.rejects(statusAssignment({
    executor: reopenPort.executor, ticket: current.ticket, assignment: ended.assignment,
  }), /cannot transition back/)
})

test('Executor status：未知状态与 ok:false 都是失败，不猜测执行状态', async () => {
  const current = planned()
  for (const receipt of [null, {}, { status: 'running' }, 'unknown', { ok: false, status: 'waiting', error: 'offline' }]) {
    let calls = 0
    const { executor } = executorStub({ status: async () => { calls += 1; return receipt } })
    await assert.rejects(statusAssignment({ executor, ticket: current.ticket, assignment: current.assignment }))
    assert.equal(current.assignment.status, 'assigned')
    assert.equal(calls, 1)
  }
})

test('Executor stop：成功后进入 ended，重复 stop 幂等且不再次调用端口', async () => {
  const current = planned()
  const { executor, calls } = executorStub()
  const stopped = await stopAssignment({
    executor, ticket: current.ticket, assignment: current.assignment, reason: 'human stop',
  })
  assert.equal(stopped.assignment.status, 'ended')
  assert.equal(current.assignment.status, 'assigned')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].context.reason, 'human stop')

  const again = await stopAssignment({ executor, ticket: current.ticket, assignment: stopped.assignment })
  assert.equal(again.assignment, stopped.assignment)
  assert.equal(again.receipt, null)
  assert.equal(calls.length, 1)
})

test('Executor：抛错或 ok:false 不伪造成功状态，Ticket 与 Assignment 输入保持不变', async () => {
  const current = planned()
  const beforeTicket = structuredClone(current.ticket)
  const beforeAssignment = structuredClone(current.assignment)

  for (const method of ['start', 'prompt', 'status', 'stop']) {
    for (const failure of [new Error(`${method} failed`), { ok: false, error: `${method} rejected` }]) {
      const { executor } = executorStub({
        [method]: async () => { if (failure instanceof Error) throw failure; return failure },
      })
      const args = { executor, ticket: current.ticket, assignment: current.assignment, prompt: 'continue', reason: 'stop' }
      const invoke = {
        start: startAssignment,
        prompt: promptAssignment,
        status: statusAssignment,
        stop: stopAssignment,
      }[method]
      await assert.rejects(invoke(args), new RegExp(`${method} (failed|rejected)`))
      assert.deepEqual(current.ticket, beforeTicket)
      assert.deepEqual(current.assignment, beforeAssignment)
    }
  }
})

test('Executor：端口调用前复核 workdir、Ticket 归属与 attempts，坏 DTO 不会外发', async () => {
  const current = planned()
  const { executor, calls } = executorStub()
  for (const assignment of [
    { ...current.assignment, workdir: 'relative' },
    { ...current.assignment, ticketId: 'ticket:other' },
    { ...current.assignment, attempts: 0 },
    { ...current.assignment, sessionId: '' },
  ]) {
    await assert.rejects(startAssignment({ executor, ticket: current.ticket, assignment }))
  }
  assert.equal(calls.length, 0)
})
