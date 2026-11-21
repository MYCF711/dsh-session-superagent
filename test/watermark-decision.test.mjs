import assert from 'node:assert/strict'
import test from 'node:test'

import { createWatermarkState, observe, deliver, handle } from '../lib/rooms/watermark-state.js'
import { decideWatermark } from '../lib/rooms/watermark-decision.js'

const NOW = Date.parse('2026-11-21T12:00:00.000Z')
const AT = new Date(NOW).toISOString()
const rec = (key, cursor, extra = {}) => ({ key, cursor, item: { key, ...extra } })
const keys = (list) => list.map((entry) => entry.key)

test('决策房：新条目为 fresh，已有基线且未变化为 unchanged', () => {
  const state = observe(createWatermarkState(), 'issue:1', 'a', { round: 1 })
  const out = decideWatermark({ items: [rec('issue:1', 'a'), rec('issue:2', 'b')], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.fresh), ['issue:2'])
  assert.deepEqual(keys(out.unchanged), ['issue:1'])
})

test('决策房：未列条目不靠 pending 存储也会持续候选，下一轮成为正文', () => {
  let state = createWatermarkState()
  const items = [rec('issue:1', 'a'), rec('issue:2', 'b'), rec('issue:3', 'c')]
  for (const entry of items) state = observe(state, entry.key, 'baseline', { round: state.round + 1 })
  const first = decideWatermark({ items, obs: state.obs, batchLimit: 1, now: NOW })
  assert.deepEqual(keys(first.listed), ['issue:1'])
  assert.deepEqual(keys(first.rest), ['issue:2', 'issue:3'])

  state = deliver(state, 'issue:1', 'a', { round: state.round + 1, at: AT })
  const second = decideWatermark({ items, obs: state.obs, batchLimit: 1, now: NOW })
  assert.deepEqual(keys(second.fresh), ['issue:2', 'issue:3'], '已交付的 #1 不再抢占 fresh 位置')
  assert.deepEqual(keys(second.listed), ['issue:2'])
  assert.deepEqual(keys(second.rest), ['issue:3'])
})

test('决策房：ack 自己的新 cursor 是 handled，不 fresh、不 retry', () => {
  let state = observe(createWatermarkState(), 'issue:7', 'before', { round: 1 })
  state = deliver(state, 'issue:7', 'before', { round: 2, at: AT })
  state = handle(state, 'issue:7', 'own-ack', { round: 3, at: AT })
  const out = decideWatermark({ items: [rec('issue:7', 'own-ack')], obs: state.obs, now: NOW + 999999 })
  assert.deepEqual(keys(out.handled), ['issue:7'])
  assert.equal(out.fresh.length, 0)
  assert.equal(out.retry.length, 0)
})

test('决策房：ack 后真正的外部更新再次成为 fresh', () => {
  let state = observe(createWatermarkState(), 'issue:7', 'before', { round: 1 })
  state = handle(state, 'issue:7', 'own-ack', { round: 2, at: AT })
  const out = decideWatermark({ items: [rec('issue:7', 'external')], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.fresh), ['issue:7'])
})

test('决策房：retry 从 delivered/handled 派生，遵守冷却与最多次数', () => {
  let state = observe(createWatermarkState(), 'issue:7', 'a', { round: 1 })
  state = deliver(state, 'issue:7', 'a', { round: 2, at: AT })
  const input = { items: [rec('issue:7', 'a')], obs: state.obs, cooldownMs: 600000, maxRetries: 2 }
  assert.deepEqual(keys(decideWatermark({ ...input, now: NOW + 1000 }).waiting), ['issue:7'])
  assert.deepEqual(keys(decideWatermark({ ...input, now: NOW + 600000 }).retry), ['issue:7'])

  state = deliver(state, 'issue:7', 'a', { round: 3, at: AT })
  assert.deepEqual(keys(decideWatermark({ ...input, obs: state.obs, now: NOW + 999999 }).exhausted), ['issue:7'])
})

test('决策房：ack #7 不改变 #8 的候选，彻底没有全局 floor', () => {
  let state = createWatermarkState()
  state = observe(state, 'issue:7', '7-old', { round: 1 })
  state = observe(state, 'issue:8', '8-old', { round: 2 })
  state = handle(state, 'issue:7', '7-acked', { round: 3, at: AT })
  const out = decideWatermark({
    items: [rec('issue:7', '7-acked'), rec('issue:8', '8-new')], obs: state.obs, now: NOW,
  })
  assert.deepEqual(keys(out.handled), ['issue:7'])
  assert.deepEqual(keys(out.fresh), ['issue:8'])
})

test('决策房：评论截断只交付到第 10 条时，第 11 条仍是下一轮 fresh', () => {
  let state = observe(createWatermarkState(), 'pr:9/comment', 0, { round: 1 })
  state = deliver(state, 'pr:9/comment', 10, { round: 2, at: AT })
  const out = decideWatermark({ items: [rec('pr:9/comment', 11)], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.fresh), ['pr:9/comment'])
})

test('决策房：限额只影响本轮 listed，不消费 fresh/retry', () => {
  const state = observe(createWatermarkState(), 'issue:1', 'old', { round: 1 })
  const out = decideWatermark({
    items: [rec('issue:1', 'new')], obs: state.obs, batchLimit: 5,
    wakeTimes: [NOW - 1000, NOW - 2000], maxWakesPerHour: 2, now: NOW,
  })
  assert.equal(out.capped, true)
  assert.deepEqual(keys(out.fresh), ['issue:1'])
  assert.equal(out.listed.length, 0)
  assert.deepEqual(keys(out.deferred), ['issue:1'])
  assert.equal(out.budget.used, 2)
  assert.equal(out.budget.remaining, 0)
})

test('决策房：legacy 行先对齐，不与新版 cursor 直接比较', () => {
  const state = createWatermarkState({ obs: {
    'issue:7': { cursor: 'v1:old', delivered: null, handled: null, retries: 0, round: 0, legacy: true },
  } })
  const out = decideWatermark({ items: [rec('issue:7', 'h:new')], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.baseline), ['issue:7'])
  assert.equal(out.fresh.length, 0)
})

test('决策房：非法输入返回空决策，不让单条坏数据打挂整轮', () => {
  const out = decideWatermark({ items: [null, { key: '', cursor: 'x' }, rec('issue:1', 'a')], obs: null, now: NOW })
  assert.deepEqual(keys(out.fresh), ['issue:1'])
  assert.equal(out.invalid.length, 2)
})

test('决策房：v1 tries=0 的未列条目迁移后仍 fresh，不进入重试冷却', async () => {
  const { migrateV1Watermark } = await import('../lib/rooms/watermark-state.js')
  let state = migrateV1Watermark({
    kind: 'issue', seen: { 131: 'old' }, pending: { 131: { at: AT, tries: 0 } },
  })
  state = observe(state, 'issue:131', 'h:current', { round: state.round + 1 })
  const out = decideWatermark({ items: [rec('issue:131', 'h:current')], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.fresh), ['issue:131'])
  assert.equal(out.waiting.length, 0)
})

test('决策房：force observe 仅消费观察，不伪装交付，后续新内容仍 fresh', () => {
  let state = observe(createWatermarkState(), 'issue:1', 'a', { round: 1, force: true })
  let out = decideWatermark({ items: [rec('issue:1', 'a')], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.unchanged), ['issue:1'])
  assert.equal(state.obs['issue:1'].delivered, null)
  out = decideWatermark({ items: [rec('issue:1', 'b')], obs: state.obs, now: NOW })
  assert.deepEqual(keys(out.fresh), ['issue:1'])
})

test('决策房：支持数据源注入 cursor 比较器', () => {
  const state = observe(createWatermarkState(), 'issue:1', 7, { round: 1 })
  const out = decideWatermark({
    items: [rec('issue:1', '7')], obs: state.obs,
    sameCursor: (left, right) => String(left) === String(right), now: NOW,
  })
  assert.deepEqual(keys(out.unchanged), ['issue:1'])
})
