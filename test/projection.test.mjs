import assert from 'node:assert/strict'
import test from 'node:test'

import { createWatermarkState, observe, deliver, handle } from '../lib/rooms/watermark-state.js'
import { projectWatcher, projectWatchers } from '../lib/rooms/projection.js'

const NOW = Date.parse('2026-11-21T12:00:00.000Z')
const AT = new Date(NOW - 1000).toISOString()
const rec = (key, cursor) => ({ key, cursor, item: { key } })

test('投影房：同一 obs + 当前条目得到统一 fresh/retry/handled 计数', () => {
  let state = createWatermarkState({ id: 'o/r#s', repo: 'o/r' })
  state = observe(state, 'issue:1', 'old', { round: 1 })
  state = observe(state, 'issue:2', 'b', { round: 2 })
  state = deliver(state, 'issue:2', 'b', { round: 3, at: AT })
  state = observe(state, 'issue:3', 'c', { round: 4 })
  state = handle(state, 'issue:3', 'ack', { round: 5, at: AT })
  const before = structuredClone(state)
  const view = projectWatcher(state, {
    items: [rec('issue:1', 'new'), rec('issue:2', 'b'), rec('issue:3', 'ack')],
    now: NOW, cooldownMs: 0,
  })
  assert.equal(view.freshCount, 1)
  assert.equal(view.retryCount, 1)
  assert.equal(view.handledCount, 1)
  assert.equal(view.candidateCount, 2)
  assert.equal(view.lastDeliveryAt, AT)
  assert.equal(view.lastHandledAt, AT)
  assert.deepEqual(state, before, '投影不得修改输入')
})

test('投影房：paused/error/deferred/running 是互斥状态', () => {
  const cases = [
    [{ enabled: false }, 'paused'],
    [{ enabled: true, lastError: 'bad' }, 'error'],
    [{ enabled: true, nextAt: NOW + 1000, deferReason: 'backoff' }, 'deferred'],
    [{ enabled: true }, 'running'],
  ]
  for (const [fields, expected] of cases) {
    assert.equal(projectWatcher({ watermarkVersion: 2, obs: {}, ...fields }, { now: NOW }).status, expected)
  }
})

test('投影房：v1 老守也能只读投影，pending 不需要先迁移', () => {
  const view = projectWatcher({
    repo: 'o/r', seen: { 1: 'old' }, pending: { 1: { tries: 1, at: AT } }, enabled: true,
  }, { now: NOW })
  assert.equal(view.watermarkVersion, 1)
  assert.equal(view.candidateCount, 1)
  assert.equal(view.legacyCount, 1)
})

test('投影房：返回冻结视图，调用方不能回写状态', () => {
  const view = projectWatcher(createWatermarkState({ repo: 'o/r' }))
  assert.equal(Object.isFrozen(view), true)
  assert.equal(Object.isFrozen(view.budget), true)
  assert.throws(() => { view.status = 'error' }, TypeError)
  assert.equal('obs' in view, false, '内部可写状态表不暴露给面板')
})

test('投影房：多条守的状态计数严格分区，总数一致', () => {
  const views = projectWatchers({ watchers: {
    a: { enabled: false, obs: {} },
    b: { enabled: true, lastError: 'bad', obs: {} },
    c: { enabled: true, nextAt: NOW + 1000, obs: {} },
    d: { enabled: true, obs: {} },
  } }, { now: NOW })
  assert.equal(views.length, 4)
  const counts = views.reduce((map, view) => ({ ...map, [view.status]: (map[view.status] || 0) + 1 }), {})
  assert.deepEqual(counts, { paused: 1, error: 1, deferred: 1, running: 1 })
})

test('投影房：能力清单原样只读暴露，缺字段安全', () => {
  const view = projectWatcher(null, { capabilities: ['issues'] })
  assert.equal(view.repo, null)
  assert.deepEqual(view.capabilities, ['issues'])
  assert.equal(view.candidateCount, 0)
})
