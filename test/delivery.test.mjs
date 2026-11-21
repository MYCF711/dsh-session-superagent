import assert from 'node:assert/strict'
import test from 'node:test'

import { createWatermarkState, observe } from '../lib/rooms/watermark-state.js'
import { deliverBatch, acknowledgeBatch } from '../lib/rooms/delivery.js'

const AT = '2026-11-21T12:00:00.000Z'
const rec = (key, cursor, context = {}) => ({ key, cursor, item: { key }, context })
function stateWith(...records) {
  let state = createWatermarkState()
  for (const record of records) state = observe(state, record.key, 'baseline-' + record.key, { round: state.round + 1 })
  return state
}

test('交付房：空批次不调用 send，也不推进 round', async () => {
  const state = createWatermarkState()
  let calls = 0
  const out = await deliverBatch({ state, listed: [], send: async () => { calls += 1 } })
  assert.equal(out.status, 'empty')
  assert.equal(out.state, state)
  assert.equal(calls, 0)
})

test('交付房：明确成功后只提交 listed，rest 不得提前交付', async () => {
  const listed = [rec('issue:1', 'a'), rec('issue:2', 'b')]
  const state = stateWith(...listed)
  const out = await deliverBatch({ state, listed, send: async () => ({ ok: true }), at: AT })
  assert.equal(out.status, 'delivered')
  assert.deepEqual(out.deliveredKeys, ['issue:1', 'issue:2'])
  assert.equal(out.state.obs['issue:1'].delivered.cursor, 'a')
  assert.equal(out.state.obs['issue:2'].delivered.cursor, 'b')
  assert.equal(out.state.round, 4)
})

test('交付房：ok:false / busy / throw 均不提交 delivered', async () => {
  for (const reply of [{ ok: false }, { ok: false, busy: true }, new Error('send failed')]) {
    const state = stateWith(rec('issue:1', 'a'))
    const out = await deliverBatch({
      state, listed: [rec('issue:1', 'a')],
      send: async () => { if (reply instanceof Error) throw reply; return reply },
    })
    assert.equal(out.state, state)
    assert.equal(out.state.obs['issue:1'].delivered, null)
    assert.equal(out.status, reply && reply.busy ? 'busy' : 'failed')
  }
})

test('交付房：部分回执只提交成功 key，未知/重复 key 不会污染状态', async () => {
  const state = stateWith(rec('issue:1', 'a'), rec('issue:2', 'b'))
  const out = await deliverBatch({
    state, listed: [rec('issue:1', 'a'), rec('issue:2', 'b')],
    send: async () => ({ ok: true, deliveredKeys: ['issue:2', 'issue:2', 'issue:unknown'] }),
    at: AT,
  })
  assert.equal(out.state.obs['issue:1'].delivered, null)
  assert.equal(out.state.obs['issue:2'].delivered.cursor, 'b')
  assert.deepEqual(out.deliveredKeys, ['issue:2'])
  assert.deepEqual(out.ignoredKeys, ['issue:unknown'])
})

test('交付房：ack 成功必须带回处置后 cursor，只写本行', async () => {
  const state = stateWith(rec('issue:7', 'old'), rec('issue:8', 'other'))
  const before8 = state.obs['issue:8']
  const out = await acknowledgeBatch({
    state,
    items: [rec('issue:7', 'old', { repo: 'o/r', number: 7 })],
    acknowledge: async () => ({ ok: true, cursor: 'after-ack' }),
    at: AT,
  })
  assert.equal(out.results[0].ok, true)
  assert.equal(out.state.obs['issue:7'].handled.cursor, 'after-ack')
  assert.deepEqual(out.state.obs['issue:8'], before8)
})

test('交付房：ack 缺 post-cursor 是失败，不允许制造自唤醒', async () => {
  const state = stateWith(rec('issue:7', 'old'))
  const out = await acknowledgeBatch({
    state, items: [rec('issue:7', 'old')], acknowledge: async () => ({ ok: true }),
  })
  assert.equal(out.results[0].ok, false)
  assert.match(out.results[0].error, /cursor/)
  assert.equal(out.state, state)
  assert.equal(out.state.obs['issue:7'].handled, null)
})

test('交付房：多条 ack 独立结算，一条失败不吞其他成功', async () => {
  const state = stateWith(rec('issue:7', 'a'), rec('issue:8', 'b'))
  const out = await acknowledgeBatch({
    state,
    items: [rec('issue:7', 'a'), rec('issue:8', 'b')],
    acknowledge: async (context) => context.key === 'issue:7'
      ? { ok: true, cursor: 'acked-a' }
      : { ok: false, error: 'network' },
    at: AT,
  })
  assert.equal(out.state.obs['issue:7'].handled.cursor, 'acked-a')
  assert.equal(out.state.obs['issue:8'].handled, null)
  assert.deepEqual(out.results.map((result) => result.ok), [true, false])
})
