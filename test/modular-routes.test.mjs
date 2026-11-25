import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

const dir = tempDir('zhuli-modular-routes-')
process.env.DSH_SUPERAGENT_STATE = dir
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS = '1'
process.env.DSH_SUPERAGENT_WAKE_QUEUE_RETRY_MS = '1'
assertTempStateDir('modular-routes')
const mod = await import('../lib/index.js?modular-routes=' + Date.now())
const routes = new Map()
const tools = []
const followupCalls = []
const agent = { id: 'session-a', status: 'idle', followup(message) { followupCalls.push(message) } }
const ctx = {
  tools: { register(tool) { tools.push(tool) } },
  webServer: { register(options) { routes.set(options.path, options.handler); return () => routes.delete(options.path) } },
  agents: { currentInitiator: () => agent, get: () => agent },
  get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
}
mod.apply(ctx)

async function call(path, method = 'GET', body = null, origin = '') {
  const handler = routes.get(path)
  assert.equal(typeof handler, 'function', path)
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = origin ? { origin } : {}
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(chunk) { if (chunk) this.body += chunk; this.finished = true },
  }
  const promise = handler(req, res)
  if (method !== 'GET') {
    req.emit('data', Buffer.from(body ? JSON.stringify(body) : '{}'))
  }
  req.emit('end')
  await promise
  return { status: res.statusCode, json: () => res.body ? JSON.parse(res.body) : null }
}

test('模块化路由：Ticket stop/resume 与 /state 投影真实连通', async () => {
  await mod.__test.recordRuntimeDelivery(
    { provider: 'github', repo: 'o/r', sessionId: 'session-a', workdir: '/tmp/work' },
    { number: 1, key: 'issue:1', title: 'Ticket', updated_at: '2026-11-22T00:00:00Z' },
  )
  const stopped = await call('/session-superagent/tickets', 'POST', { action: 'stop', ticketId: 'ticket:github:o/r#1' })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.json().ticket.status, 'ended')
  const resumed = await call('/session-superagent/tickets', 'POST', { action: 'resume', ticketId: 'ticket:github:o/r#1' })
  assert.equal(resumed.status, 202)
  assert.equal(resumed.json().queued, true)
  assert.equal(resumed.json().ticket.status, 'assigned')
  const state = await call('/session-superagent/state')
  assert.equal(state.json().modular.records.total, 1)
  assert.equal(state.json().modular.records.counts.assigned, 1)
})

test('模块化路由：draft 保存/清空与 Outbox 空队列 flush', async () => {
  const saved = await call('/session-superagent/draft', 'POST', { ticketId: 'ticket:github:o/r#1', body: 'reply draft', revision: 0 })
  assert.equal(saved.status, 200)
  assert.equal(saved.json().draft.dirty, true)
  assert.equal(saved.json().draft.value.body, 'reply draft')
  const cleared = await call('/session-superagent/draft', 'POST', { ticketId: 'ticket:github:o/r#1', clear: true, revision: 1 })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json().draft.dirty, false)
  const flushed = await call('/session-superagent/outbox', 'POST', {})
  assert.equal(flushed.status, 200)
  assert.equal(flushed.json().failed, 0)
})

test('watch_start 显式 executionMode=worker 才创建 worker 守，默认仍 inline', async () => {
  const start = tools.find((tool) => tool.name === 'watch_start')
  await start.execute({ repo: 'o/worker', executionMode: 'worker' })
  await start.execute({ repo: 'o/inline' })
  const state = mod.__test.readState()
  assert.equal(state.watchers['o/worker#session-a'].executionMode, 'worker')
  assert.equal(state.watchers['o/inline#session-a'].executionMode, 'inline')
  const invalid = JSON.parse(await start.execute({ repo: 'o/invalid', executionMode: 'team', format: 'json' }))
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /inline or worker/)
})

test('draft 旧 revision 409，成功保存推进 revision 且不被旧标签页覆盖', async () => {
  const revision = mod.__test.readState().draft ? mod.__test.readState().draft.revision : 0
  const first = await call('/session-superagent/draft', 'POST', { ticketId: 'ticket:github:o/r#1', body: 'client-A', revision })
  assert.equal(first.status, 200)
  assert.equal(first.json().draft.revision, revision + 1)
  const stale = await call('/session-superagent/draft', 'POST', { ticketId: 'ticket:github:o/r#1', body: 'client-B-stale', revision })
  assert.equal(stale.status, 409)
  assert.equal(stale.json().currentRevision, revision + 1)
  const latest = await call('/session-superagent/draft', 'POST', { ticketId: 'ticket:github:o/r#1', body: 'client-C', revision: revision + 1 })
  assert.equal(latest.status, 200)
  assert.equal(latest.json().draft.revision, revision + 2)
  assert.equal(latest.json().draft.value.body, 'client-C')
})

test('inline resume 会话缺失返回 409，Ticket 保持 ended 可重试', async () => {
  await mod.__test.recordRuntimeDelivery(
    { provider: 'github', repo: 'o/r', sessionId: 'session-a', workdir: '/tmp/work' },
    { number: 99, key: 'issue:99', title: 'Missing', updated_at: '2026-11-22T00:00:00Z' },
  )
  await call('/session-superagent/tickets', 'POST', { action: 'stop', ticketId: 'ticket:github:o/r#99' })
  const originalGet = ctx.agents.get
  ctx.agents.get = () => null
  try {
    const resumed = await call('/session-superagent/tickets', 'POST', { action: 'resume', ticketId: 'ticket:github:o/r#99' })
    assert.equal(resumed.status, 409)
    assert.match(resumed.json().error, /session is missing/)
    const ticket = mod.__test.readState().tickets['ticket:github:o/r#99']
    assert.equal(ticket.status, 'ended')
    assert.equal(ticket.resumeCount, 0)
  } finally {
    ctx.agents.get = originalGet
  }
})

test('inline resume busy 后 queued 不回滚，空闲后真实投递且不重复', async () => {
  await mod.__test.recordRuntimeDelivery(
    { provider: 'github', repo: 'o/r', sessionId: 'session-a', workdir: '/tmp/work' },
    { number: 100, key: 'issue:100', title: 'Busy', updated_at: '2026-11-22T00:00:00Z' },
  )
  await call('/session-superagent/tickets', 'POST', { action: 'stop', ticketId: 'ticket:github:o/r#100' })
  agent.status = 'idle'
  const resumed = await call('/session-superagent/tickets', 'POST', { action: 'resume', ticketId: 'ticket:github:o/r#100' })
  assert.equal(resumed.status, 202)
  agent.status = 'running'
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(mod.__test.readState().tickets['ticket:github:o/r#100'].status, 'assigned')
  assert.equal(mod.__test.wakeQueueCount('session-a', ctx), 1)
  const before = followupCalls.length
  agent.status = 'idle'
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(followupCalls.length, before + 1)
  assert.equal(mod.__test.wakeQueueCount('session-a', ctx), 0)
  assert.equal(mod.__test.readState().tickets['ticket:github:o/r#100'].status, 'assigned')
})

test('worker pause/resume-processing 持久化并反映到 /state', async () => {
  const paused = await call('/session-superagent/tickets', 'POST', { action: 'pause-processing' })
  assert.equal(paused.status, 200)
  assert.equal(paused.json().paused, true)
  assert.equal(mod.__test.readState().executorPaused, true)
  let state = await call('/session-superagent/state')
  assert.equal(state.json().modular.execution.paused, true)
  const resumed = await call('/session-superagent/tickets', 'POST', { action: 'resume-processing' })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.json().paused, false)
  state = await call('/session-superagent/state')
  assert.equal(state.json().modular.execution.paused, false)
})

test('模块化写路由拒绝跨站请求', async () => {
  const res = await call('/session-superagent/outbox', 'POST', {}, 'https://evil.example')
  assert.equal(res.status, 403)
})
