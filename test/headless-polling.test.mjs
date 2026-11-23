import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './fixtures/tmpdir.mjs'
import { pollHealth } from '../lib/watch.js'
import { loadClient, walk, deskQueue, watcher } from './fixtures/panel-harness.mjs'

const envBaseline = { ...process.env }
test.afterEach(() => {
  for (const key of Object.keys(process.env)) { if (!(key in envBaseline)) delete process.env[key] }
  Object.assign(process.env, envBaseline)
})
let sequence = 0
const nextImport = () => '../lib/index.js?headless=' + Date.now() + '-' + ++sequence
const headlessCtx = (tools) => ({
  tools: { register: (tool) => tools.push(tool) },
  agents: { currentInitiator: () => ({ id: 'session-boot' }), get: () => null },
  get: () => null, effect: (fn) => fn(), inject: () => {},
})
const enabledEntry = (id, repo, extra = {}) => ({ id, repo, provider: 'github', sessionId: 'session-boot', enabled: true, intervalSec: 60, ...extra })

test('pollHealth：重启后从未轮询 → boot-miss', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 24 * 3600 * 1000
  assert.equal(pollHealth({ lastPoll: '2026-11-21T15:09:34.424Z', intervalSec: 300, enabled: true }, { now, bootAt }).state, 'boot-miss')
})

test('pollHealth：刚轮询为 ok，启动豁免期为 grace', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 60 * 1000
  assert.equal(pollHealth({ lastPoll: new Date(now - 60 * 1000).toISOString(), intervalSec: 300, enabled: true }, { now, bootAt }).state, 'ok')
  assert.equal(pollHealth({ lastPoll: new Date(now - 3600 * 1000).toISOString(), intervalSec: 300, enabled: true }, { now, bootAt }).state, 'grace')
})

test('pollHealth：进程跑了很久但轮询停在半路 → stalled', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 24 * 3600 * 1000
  assert.equal(pollHealth({ lastPoll: new Date(now - 2 * 3600 * 1000).toISOString(), intervalSec: 300, enabled: true }, { now, bootAt }).state, 'stalled')
})

test('pollHealth：暂停、从未轮询和非法时间都不冒充故障', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 24 * 3600 * 1000
  assert.equal(pollHealth({ lastPoll: null, intervalSec: 300, enabled: true }, { now, bootAt }).state, 'never')
  assert.equal(pollHealth({ lastPoll: '2026-11-21T15:09:34.424Z', intervalSec: 300, enabled: false }, { now, bootAt }).state, 'paused')
  assert.equal(pollHealth({ lastPoll: 'not-a-date', intervalSec: 300, enabled: true }, { now, bootAt }).state, 'never')
})

test('pollHealth：未来退避、活跃时段外和业务 defer 都是正常等待', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 24 * 3600 * 1000
  const base = { lastPoll: new Date(now - 2 * 3600 * 1000).toISOString(), intervalSec: 300, enabled: true }
  assert.equal(pollHealth({ ...base, nextAt: new Date(now + 30 * 60 * 1000).toISOString() }, { now, bootAt }).state, 'deferred')
  assert.equal(pollHealth({ ...base, activeHours: '02:00-03:00' }, { now, bootAt }).state, 'deferred')
  assert.equal(pollHealth({ ...base, deferReason: 'session-busy' }, { now, bootAt }).state, 'deferred')
})

test('pollHealth：false/0/no/off 都与调度器一样算暂停', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 24 * 3600 * 1000
  for (const enabled of [false, 0, '0', 'false', 'no', 'off']) {
    assert.equal(pollHealth({ lastPoll: '2026-11-21T15:09:34.424Z', intervalSec: 300, enabled }, { now, bootAt }).state, 'paused', String(enabled))
  }
})

test('pollHealth：新守首轮豁免，创建已久仍无首轮则报 boot-miss', () => {
  const now = Date.parse('2026-11-22T16:00:00Z')
  const bootAt = now - 24 * 3600 * 1000
  assert.equal(pollHealth({ lastPoll: null, createdAt: new Date(now - 60 * 1000).toISOString(), enabled: true }, { now, bootAt }).state, 'never')
  assert.equal(pollHealth({ lastPoll: null, createdAt: new Date(now - 2 * 24 * 3600 * 1000).toISOString(), enabled: true }, { now, bootAt }).state, 'boot-miss')
})

test('headless 重启必须挂载 enabled 守，paused 不挂载', async () => {
  const dir = tempDir('zhuli-headless-boot-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  delete process.env.DSH_SUPERAGENT_NO_POLL
  const state = { schemaVersion: 1, watchers: {
    'o/live#session-boot': enabledEntry('o/live#session-boot', 'o/live'),
    'o/paused#session-boot': { ...enabledEntry('o/paused#session-boot', 'o/paused'), enabled: false },
    'pr:o/live-pr#session-boot': enabledEntry('pr:o/live-pr#session-boot', 'o/live-pr', { kind: 'pr' }),
  } }
  writeFileSync(join(dir, 'watchers.json'), JSON.stringify(state, null, 1))
  const tools = []
  const mod = await import(nextImport())
  mod.apply(headlessCtx(tools))
  assert.equal(mod.__test.watchTimerPending('o/live#session-boot'), true)
  assert.equal(mod.__test.watchTimerPending('pr:o/live-pr#session-boot'), true)
  assert.equal(mod.__test.watchTimerPending('o/paused#session-boot'), false)
  await tools.find((tool) => tool.name === 'watch_stop').execute({ repo: 'o/live' })
  await tools.find((tool) => tool.name === 'watch_pr_stop').execute({ repo: 'o/live-pr' })
})

test('watch_doctor：重启后还没轮询过必须指出启动挂载可能失败', async () => {
  const dir = tempDir('zhuli-headless-doctor-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  const tools = []
  const mod = await import(nextImport())
  mod.apply(headlessCtx(tools))
  await tools.find((tool) => tool.name === 'watch_start').execute({ repo: 'acme/bootfail' })
  const restoreBoot = mod.__test.setBootAt(Date.now() - 10 * 60 * 1000)
  try {
    const state = mod.__test.readState()
    const key = Object.keys(state.watchers)[0]
    state.watchers[key].lastPoll = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    state.server = { ...(state.server || {}), startedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() }
    mod.__test.writeState(state)
    const text = String(await tools.find((tool) => tool.name === 'watch_doctor').execute({}))
    assert.ok(text.includes('重启后还没轮询过'), text.slice(0, 400))
    assert.ok(!text.includes('刚重启'), text.slice(0, 400))
    assert.ok(!text.includes('定时器可能丢了'), text.slice(0, 400))
  } finally {
    restoreBoot()
  }
})

test('单守挂载异常不连累其他守，且 lastError 真实落盘', async () => {
  const dir = tempDir('zhuli-headless-isolation-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  delete process.env.DSH_SUPERAGENT_NO_POLL
  const state = { schemaVersion: 1, watchers: {
    'o/bad#session-boot': enabledEntry('o/bad#session-boot', 'o/bad'),
    'o/good#session-boot': enabledEntry('o/good#session-boot', 'o/good'),
  } }
  writeFileSync(join(dir, 'watchers.json'), JSON.stringify(state, null, 1))
  const originalSetInterval = globalThis.setInterval
  let injected = false
  globalThis.setInterval = (fn, ms, ...args) => {
    if (!injected && Number(ms) === 60000) {
      injected = true
      throw new Error('mount boom')
    }
    return originalSetInterval(fn, ms, ...args)
  }
  const tools = []
  try {
    const mod = await import(nextImport())
    mod.apply(headlessCtx(tools))
    assert.equal(injected, true)
    assert.equal(mod.__test.watchTimerPending('o/good#session-boot'), true)
    assert.equal(mod.__test.watchTimerPending('o/bad#session-boot'), false)
    assert.match(String(mod.__test.readState().watchers['o/bad#session-boot'].lastError || ''), /mount boom/)
    assert.match(readFileSync(join(dir, 'watchers.json'), 'utf8'), /mount boom/)
    await tools.find((tool) => tool.name === 'watch_stop').execute({ repo: 'o/good' })
  } finally {
    globalThis.setInterval = originalSetInterval
  }
})

function nodeText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join(' ')
  return nodeText(node.props && node.props.children)
}

test('停摆守必须进入异常/问题筛选，不能继续只显示主理中', () => {
  const client = loadClient()
  const desk = client.registrations.find((registration) => registration.opts.id === 'session-superagent-desk')
  const snap = { loading: false, error: null, body: { credentials: {}, watchers: [watcher('acme/stall', {
    id: 'acme/stall#s1', title: '无头守', enabled: true, poll: 'stalled', lastPoll: '2026-11-21T00:00:00Z',
  })] } }
  const queue = deskQueue(snap)
  const hasOpen = (nodes) => nodes.some((node) => String(node.props && node.props.className || '').includes('dt-open') && nodeText(node).includes('acme/stall'))
  queue[18] = 'error'
  const errorNodes = walk(client.render(desk, queue, { sessionId: 's1' }))
  assert.equal(hasOpen(errorNodes), true, '异常筛选必须保留停摆守')
  assert.ok(errorNodes.some((node) => String(node.props && node.props.className || '').includes('dt-tag') && nodeText(node) === '异常'), '状态标签必须是异常')
  assert.ok(errorNodes.some((node) => String(node.props && node.props.className || '').includes('dt-state-dot') && node.props && node.props['data-state'] === 'error'), '按仓库汇总也必须是错误点：' + JSON.stringify(errorNodes.filter((node) => node.props && node.props['data-state']).map((node) => ({ type: node.type, className: node.props.className, state: node.props['data-state'] }))))
  queue[18] = null
  queue[17] = true
  const problemNodes = walk(client.render(desk, queue, { sessionId: 's1' }))
  assert.equal(hasOpen(problemNodes), true, '只看有问题也必须保留停摆守')
})
