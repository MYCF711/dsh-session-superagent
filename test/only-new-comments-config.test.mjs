import assert from 'node:assert/strict'
import test from 'node:test'

import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-only-comments-config-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
process.env.DSH_SUPERAGENT_UPDATE_OFFLINE = '1'
assertTempStateDir('only-new-comments-config.test.mjs')

const mod = await import('../lib/index.js?only-comments-config=' + Date.now())
const tools = []
const routes = new Map()
const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  agents: { get: () => null, currentInitiator: () => ({ id: 'session-config' }) },
  get: () => null, on() {}, effect: (fn) => fn(), inject: () => {},
}
mod.apply(ctx)

function makeReq(method, url, body) {
  const handlers = {}
  const req = {
    method, url, headers: {},
    on(event, cb) { ;(handlers[event] ||= []).push(cb); return req },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const cb of handlers.data || []) cb(Buffer.from(JSON.stringify(body)))
    for (const cb of handlers.end || []) cb()
  })
  return req
}

function makeRes() {
  return {
    statusCode: 200, chunks: [],
    setHeader() {},
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk) },
    json() { return JSON.parse(this.chunks.join('')) },
  }
}

async function call(method, path, body) {
  const res = makeRes()
  await routes.get(path.split('?')[0]).handler(makeReq(method, path, body), res)
  return res
}

test('watch_start 声明、保存、部分更新与 watch_status 自查 onlyNewComments', async () => {
  const start = tools.find((tool) => tool.name === 'watch_start')
  assert.equal(start.parameters.properties.onlyNewComments.type, 'boolean')
  assert.match(start.parameters.properties.priority.description, /只调整.*排序|只.*排序/)
  const created = JSON.parse(await start.execute({ repo: 'acme/tool-comments', onlyNewComments: true, format: 'json' }))
  assert.equal(created.filters.onlyNewComments, true)
  assert.equal(mod.__test.readState().watchers['acme/tool-comments#session-config'].filters.onlyNewComments, true)

  await start.execute({ repo: 'acme/tool-comments', labels: ['bug'] })
  assert.equal(mod.__test.readState().watchers['acme/tool-comments#session-config'].filters.onlyNewComments, true)
  const status = tools.find((tool) => tool.name === 'watch_status')
  const json = JSON.parse(await status.execute({ format: 'json' }))
  assert.equal(json.watchers.find((watcher) => watcher.repo === 'acme/tool-comments').onlyNewComments, true)
  assert.match(String(await status.execute({})), /只看新评论/)
})

test('HTTP filters 与 /state 投影完整保留 onlyNewComments', async () => {
  const created = await call('POST', '/session-superagent/watch', {
    repo: 'acme/http-comments', sessionId: 'session-config', filters: { onlyNewComments: true },
  })
  assert.equal(created.statusCode, 200)
  const id = created.json().id
  await call('POST', '/session-superagent/watch', {
    repo: 'acme/http-comments', sessionId: 'session-config', filters: { labels: ['bug'] },
  })
  let state = (await call('GET', '/session-superagent/state?sessionId=session-config')).json()
  let watcher = state.watchers.find((item) => item.id === id)
  assert.equal(watcher.filters.onlyNewComments, true)
  assert.deepEqual(watcher.filters.labels, ['bug'])

  await call('POST', '/session-superagent/watch', {
    repo: 'acme/http-comments', sessionId: 'session-config', filters: { onlyNewComments: false },
  })
  state = (await call('GET', '/session-superagent/state?sessionId=session-config')).json()
  watcher = state.watchers.find((item) => item.id === id)
  assert.equal(watcher.filters.onlyNewComments, undefined, '默认 false 在 /state 省略，客户端按 false 读取')
  assert.equal(mod.__test.readState().watchers['acme/http-comments#session-config'].filters.onlyNewComments, false,
    '显式关闭仍写入状态文件，watch_status 继续回传布尔')
  assert.deepEqual(watcher.filters.labels, ['bug'])
})
