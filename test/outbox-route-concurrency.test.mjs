import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

const dir = tempDir('zhuli-outbox-route-race-')
process.env.DSH_SUPERAGENT_STATE = dir
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
assertTempStateDir('outbox-route-race')
const mod = await import('../lib/index.js?outbox-route-race=' + Date.now())
const routes = new Map()
const ctx = {
  tools: { register() {} },
  webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
  agents: { currentInitiator: () => ({ id: 'session-a' }), get: () => null },
  get: () => null, effect: (fn) => fn(), inject: () => {},
}
let release
let startedResolve
const started = new Promise((resolve) => { startedResolve = resolve })
const gate = new Promise((resolve) => { release = resolve })
let sends = 0
const provider = {
  name: 'fake',
  capabilities: () => ['issues', 'ack'],
  list: async () => ({ ok: true, items: [] }),
  keyOf: (item) => String(item.number),
  cursorOf: (item) => String(item.updated_at || ''),
  compareCursor: (left, right) => left === right,
  async acknowledge() {
    sends += 1
    startedResolve()
    await gate
    return { ok: true, cursor: 'h:fake' }
  },
}
mod.apply(ctx, { providers: [provider] })
const at = new Date().toISOString()
mod.__test.writeState({ watchers: { 'fake:o/r#session-a': { id: 'fake:o/r#session-a', provider: 'fake', repo: 'o/r', sessionId: 'session-a', enabled: true, ackLabel: 'A:done' } } })
mod.__test.commitModularState(0, (disk) => ({
  ...disk,
  outbox: [{ id: 'm1', ticketId: 'ticket:fake:o/r#1', channel: { type: 'ack', watcherId: 'fake:o/r#session-a', repo: 'o/r', number: '1', label: 'A:done', kind: 'issue', comment: false }, body: '', status: 'pending', attempts: 0, nextAt: at, createdAt: at, updatedAt: at }],
}))

async function flush() {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/session-superagent/outbox'
  req.headers = {}
  const res = { statusCode: 0, body: '', setHeader() {}, end(chunk) { if (chunk) this.body += chunk } }
  const pending = routes.get('/session-superagent/outbox')(req, res)
  req.emit('data', Buffer.from('{}'))
  req.emit('end')
  await pending
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') }
}

test('并发 POST /outbox 共享单飞，recover 不得重复外发同一消息', async () => {
  const first = flush()
  const second = flush()
  await new Promise((resolve) => setTimeout(resolve, 50))
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(sends, 1, JSON.stringify({ left, right }))
  assert.equal(left.status, 200)
  assert.equal(right.status, 200)
  assert.equal(left.body.sent, 1)
  assert.equal(right.body.sent, 1)
  const state = mod.__test.readState()
  assert.equal(state.outbox[0].status, 'sent')
  assert.equal(state.outbox[0].attempts, 1)
})
