import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir } from './fixtures/tmpdir.mjs'

// 回归：同一仓库被多个会话同时守时，watch_ack 必须按「当前会话」解析记录，
// 不能取 Object.values(watchers) 里第一条同仓库的守。
// 依据：外部 issue #54 —— A 会话说 ack，结果打了 B 的标签、推进了 B 的水位。
process.env.DSH_SUPERAGENT_STATE = tempDir('superagent-ack-session-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'

const { apply, __test } = await import('../lib/index.js')

function makeCtx(sessionId) {
  const tools = []
  const routes = new Map()
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    agents: { get: () => null, currentInitiator: () => ({ id: sessionId }) },
    get: () => null,
    effect: (fn) => fn(),
    inject: () => {},
  }
  apply(ctx)
  return { ctx, tools, routes }
}

test('watch_ack 按当前会话解析 watcher：不串标签、不串水位（issue #54）', async () => {
  const { tools } = makeCtx('session-A')
  const ack = tools.find((tool) => tool.name === 'watch_ack')
  assert.ok(ack, 'watch_ack 必须注册')

  // 故意把 B 放在前面：以前的实现会选中 B（Object.values 的第一条）
  __test.writeState({
    watchers: {
      'o/r#session-B': {
        id: 'o/r#session-B', repo: 'o/r', provider: 'github', sessionId: 'session-B',
        intervalSec: 60, enabled: true, ackLabel: 'be-已读', cursor: null, seen: {}, lastReported: {},
      },
      'o/r#session-A': {
        id: 'o/r#session-A', repo: 'o/r', provider: 'github', sessionId: 'session-A',
        intervalSec: 60, enabled: true, ackLabel: 'po-已读', cursor: null, seen: {}, lastReported: {},
      },
    },
  })

  const out = JSON.parse(String(await ack.execute({ repo: 'o/r', number: 11, format: 'json' })))
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.label, 'po-已读', 'A 的 ack 必须用 A 自己的标签，不能拿 B 的')

  const state = __test.readState()
  const a = state.watchers['o/r#session-A']
  const b = state.watchers['o/r#session-B']
  assert.ok(a.seen && a.seen['11'], 'A 自己的水位要被推进')
  assert.ok(a.cursor, 'A 自己的 cursor 要被推进')
  assert.ok(!b.seen || !b.seen['11'], 'B 的水位不能被 A 的 ack 推进')
  assert.ok(!b.cursor, 'B 的 cursor 不能被 A 的 ack 推进')
})

test('不给 repo 时也只挑当前会话的守（同仓库多会话）', async () => {
  const { tools } = makeCtx('session-A')
  const ack = tools.find((tool) => tool.name === 'watch_ack')
  __test.writeState({
    watchers: {
      'o/r#session-B': {
        id: 'o/r#session-B', repo: 'o/r', provider: 'github', sessionId: 'session-B',
        intervalSec: 60, enabled: true, ackLabel: 'be-已读', cursor: null, seen: {}, lastReported: {},
      },
      'o/r#session-A': {
        id: 'o/r#session-A', repo: 'o/r', provider: 'github', sessionId: 'session-A',
        intervalSec: 60, enabled: true, ackLabel: 'po-已读', cursor: null, seen: {}, lastReported: {},
      },
    },
  })
  const out = JSON.parse(String(await ack.execute({ number: 12, format: 'json' })))
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.label, 'po-已读')
  const state = __test.readState()
  assert.ok(state.watchers['o/r#session-A'].seen && state.watchers['o/r#session-A'].seen['12'])
  assert.ok(!state.watchers['o/r#session-B'].seen || !state.watchers['o/r#session-B'].seen['12'])
})
