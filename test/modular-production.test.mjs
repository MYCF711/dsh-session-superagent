import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

async function setup(tag) {
  const dir = tempDir('zhuli-modular-production-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  assertTempStateDir(tag)
  const mod = await import('../lib/index.js?' + tag + '=' + Date.now())
  return { mod, dir }
}

function workerHost(calls) {
  const agent = {
    id: 'worker-ticket:github:o/r#1', status: 'idle',
    followup(message) { calls.push(message); this.status = 'running' },
    cancel() {},
  }
  return {
    sessionController: {
      async resolveAgent(id) { return calls.created ? { agent } : { error: { code: 'session/not-found', message: 'missing' } } },
      async create() { calls.created = true },
    },
    workspaceRegistry: { async create() { return { id: 'ws-1' } } },
  }
}

test('生产 worker：Ticket 先落盘，Outbox 创建独立 session，同事件重放不重复 prompt', async () => {
  const { mod } = await setup('worker-production')
  const calls = []
  const ctx = workerHost(calls)
  const entry = { provider: 'github', repo: 'o/r', sessionId: 'session-a', workdir: '/tmp/work', executionMode: 'worker' }
  const item = { number: 1, key: 'issue:1', title: 'Fix', body: 'Implement', updated_at: '2026-11-22T00:00:00Z' }
  const first = await mod.__test.deliverWorkerItem(ctx, entry, item, 'work on issue')
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.ticketId, 'ticket:github:o/r#1')
  assert.equal(calls.length, 1)
  assert.match(calls[0].id, /^worker:/)
  const state = mod.__test.readState()
  assert.equal(state.tickets[first.ticketId].status, 'assigned')
  assert.equal(state.assignments[state.tickets[first.ticketId].assignmentId].sessionId, 'worker-ticket:github:o/r#1')
  assert.equal(state.outbox[0].status, 'sent')

  const second = await mod.__test.deliverWorkerItem(ctx, entry, item, 'work on issue')
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(calls.length, 1, '同一 cursor 不得重复 prompt')
})

test('生产 inline：唤醒后登记当前 session Ticket，不触达 worker', async () => {
  const { mod } = await setup('inline-production')
  const entry = { provider: 'github', repo: 'o/r', sessionId: 'session-a', workdir: '/tmp/work' }
  const routed = await mod.__test.recordRuntimeDelivery(entry, { number: 2, key: 'issue:2', title: 'Inline', updated_at: '2026-11-22T00:00:00Z' })
  assert.equal(routed.ticket.id, 'ticket:github:o/r#2')
  assert.equal(routed.ticket.ownerSessionId, 'session-a')
  assert.equal(routed.assignment.sessionId, 'session-a')
  assert.equal(routed.disposition, 'deliver')
})

test('生产身份：bot 与无评论系统事件不得复活 ended Ticket', async () => {
  const { mod } = await setup('actor-production')
  const entry = { provider: 'github', repo: 'o/r', sessionId: 'session-a', workdir: '/tmp/work' }
  const original = { number: 7, key: 'issue:7', title: 'Bot', updated_at: '2026-11-22T00:00:00Z' }
  await mod.__test.recordRuntimeDelivery(entry, original)
  await mod.__test.completeRuntimeForAck({}, entry, 7, 'done')
  const bot = await mod.__test.recordRuntimeDelivery(entry, {
    ...original, updated_at: '2026-11-22T01:00:00Z', lastComment: { login: 'github-actions[bot]', self: false },
  })
  assert.equal(bot.disposition, 'eval')
  assert.equal(bot.ticket.status, 'ended')
  assert.equal(bot.ticket.resumeCount, 0)
  const system = await mod.__test.recordRuntimeDelivery(entry, { ...original, updated_at: '2026-11-22T02:00:00Z' })
  assert.equal(system.disposition, 'eval')
  assert.equal(system.ticket.status, 'ended')
})
