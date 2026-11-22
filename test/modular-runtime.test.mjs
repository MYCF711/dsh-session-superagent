import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createModularRuntimeState,
  ensureTicket,
  startRuntimeAssignment,
  routeRuntimeEvent,
  completeRuntimeTicket,
  projectRuntime,
  renderRuntimePrompt,
  evaluateAdmission,
  runtimeThreadKey,
} from '../lib/rooms/modular-runtime.js'

const AT = '2026-11-22T00:00:00.000Z'
const base = { provider: 'github', repo: 'o/r', number: 1, workdir: '/tmp/ticket-1', at: AT }

function executorPort(calls = []) {
  return {
    async start(input) { calls.push(['start', input]); return { ok: true, sessionId: input.assignment.sessionId } },
    async prompt(input) { calls.push(['prompt', input]); return { ok: true } },
    async status() { return { ok: true, status: 'assigned' } },
    async stop(input) { calls.push(['stop', input]); return { ok: true } },
  }
}

test('运行时：inline 创建 Ticket/Assignment/订阅，默认不触达 Executor 且幂等', () => {
  const first = ensureTicket({}, { ...base, sessionId: 'session-a', eventId: 'wake-1' })
  assert.equal(first.mode, 'inline')
  assert.equal(first.ticket.status, 'assigned')
  assert.equal(first.ticket.ownerSessionId, 'session-a')
  assert.equal(first.assignment.sessionId, 'session-a')
  assert.equal(first.state.subscriptions.subscriptions['github:o/r#1'].ticketId, first.ticket.id)
  assert.equal(first.ticket.history.length, 2)
  const second = ensureTicket(first.state, { ...base, sessionId: 'session-a', eventId: 'wake-1' })
  assert.equal(second.action, 'reuse')
  assert.equal(second.ticket, first.ticket)
  assert.equal(second.assignment, first.assignment)
})

test('运行时：显式 worker 才创建独立 session，并传递 Outbox messageId', async () => {
  const calls = []
  const ensured = ensureTicket({}, { ...base, sessionId: 'session-a', mode: 'worker' })
  assert.equal(ensured.assignment.sessionId, `worker-${ensured.ticket.id}`)
  await startRuntimeAssignment(ensured.state, {
    ticketId: ensured.ticket.id, executor: executorPort(calls), prompt: 'start', messageId: 'outbox:1',
  })
  assert.equal(calls[0][0], 'start')
  assert.equal(calls[1][0], 'prompt')
  assert.equal(calls[1][1].messageId, 'outbox:1')
  const inline = ensureTicket({}, { ...base, sessionId: 'session-a' })
  await assert.rejects(startRuntimeAssignment(inline.state, { ticketId: inline.ticket.id, executor: executorPort() }), /worker assignment/)
})

test('运行时：已订阅后续 deliver 给原 worker，重复事件不重复执行', async () => {
  const calls = []
  const ensured = ensureTicket({}, { ...base, mode: 'worker', sessionId: 'session-a' })
  const event = { threadKey: runtimeThreadKey(base), id: 'comment-1', type: 'comment', actor: 'human', body: 'continue', at: AT }
  const options = { mode: 'worker', executor: executorPort(calls), workdir: base.workdir }
  const delivered = await routeRuntimeEvent(ensured.state, event, options)
  assert.equal(delivered.disposition, 'deliver')
  assert.equal(calls.filter((call) => call[0] === 'prompt').length, 1)
  const duplicate = await routeRuntimeEvent(delivered.state, event, options)
  assert.equal(duplicate.disposition, 'ignore')
  assert.equal(calls.filter((call) => call[0] === 'prompt').length, 1)
})

test('运行时：ended 的人类评论 resume 并生成下一 sequence；非人事件只 eval', async () => {
  const ensured = ensureTicket({}, { ...base, sessionId: 'session-a' })
  const completed = await completeRuntimeTicket(ensured.state, ensured.ticket.id, { at: AT, eventId: 'done-1' })
  assert.equal(completed.ticket.status, 'ended')
  assert.equal(completed.assignment.status, 'ended')
  const event = { threadKey: runtimeThreadKey(base), id: 'comment-human', type: 'comment', actor: 'human', body: 'resume', at: AT }
  const resumed = await routeRuntimeEvent(completed.state, event, { sessionId: 'session-a', workdir: base.workdir })
  assert.equal(resumed.disposition, 'resume')
  assert.equal(resumed.ticket.status, 'assigned')
  assert.equal(resumed.ticket.resumeCount, 1)
  assert.ok(resumed.assignment.id.endsWith(':2'))

  const stopped = await completeRuntimeTicket(resumed.state, resumed.ticket.id, { at: AT, eventId: 'done-2', reason: 'completed' })
  const automated = await routeRuntimeEvent(stopped.state, { ...event, id: 'comment-bot', actor: 'agent' }, { sessionId: 'session-a', workdir: base.workdir })
  assert.equal(automated.disposition, 'eval')
  assert.equal(automated.ticket.status, 'ended')
})

test('运行时：worker complete 停止真实端口并同步 ended/human-stop', async () => {
  const calls = []
  const ensured = ensureTicket({}, { ...base, sessionId: 'session-a', mode: 'worker' })
  const completed = await completeRuntimeTicket(ensured.state, ensured.ticket.id, {
    mode: 'worker', executor: executorPort(calls), reason: 'human-stop', eventId: 'stop-1',
  })
  assert.equal(completed.ticket.status, 'ended')
  assert.equal(completed.ticket.endReason, 'human-stop')
  assert.equal(completed.assignment.status, 'ended')
  assert.equal(calls[0][0], 'stop')
  assert.equal(completed.state.subscriptions.subscriptions['github:o/r#1'].endReason, 'human-stop')
})

test('运行时：投影区分空与未知，提示词和两层准入可直接使用', async () => {
  const view = projectRuntime(createModularRuntimeState({}), { health: [] })
  assert.equal(view.records.total, 0)
  assert.equal(view.records.outbox.total, null)
  assert.equal(projectRuntime({ outbox: [] }, { health: [] }).records.outbox.total, 0)
  assert.equal(view.deployment.status, 'ready')
  assert.match(renderRuntimePrompt('resume', { ticketId: 't1', reason: 'continue' }, { locale: 'en' }), /Human resume requested for t1/)
  let assessments = 0
  const decision = await evaluateAdmission({ candidate: {}, gate: () => 'reject', assessment: () => { assessments += 1; return 'accept' } })
  assert.equal(decision.disposition, 'reject')
  assert.equal(assessments, 0)
})

test('运行时：inline/worker 切换结束旧派工并创建下一世代', async () => {
  const inline = ensureTicket({}, { ...base, sessionId: 'session-a', eventId: 'initial' })
  const calls = []
  const executor = executorPort(calls)
  const event = { threadKey: runtimeThreadKey(base), id: 'switch-event', type: 'comment', actor: 'human', body: 'continue', at: AT }
  const worker = await routeRuntimeEvent(inline.state, event, {
    mode: 'worker', sessionId: 'session-a', workdir: base.workdir, deferExecution: true, executor,
  })
  assert.equal(worker.assignment.sessionId, `worker-${worker.ticket.id}`)
  assert.ok(worker.assignment.id.endsWith(':2'))
  assert.equal(worker.state.assignments[inline.assignment.id].status, 'ended')
  await startRuntimeAssignment(worker.state, { ticketId: worker.ticket.id, executor, prompt: 'worker' })

  const back = await routeRuntimeEvent(worker.state, { ...event, id: 'switch-back' }, {
    mode: 'inline', sessionId: 'session-a', workdir: base.workdir, deferExecution: true, executor,
  })
  assert.equal(back.assignment.sessionId, 'session-a')
  assert.ok(back.assignment.id.endsWith(':3'))
  assert.equal(back.state.assignments[worker.assignment.id].status, 'ended')
  assert.ok(calls.some((call) => call[0] === 'stop'))
})
