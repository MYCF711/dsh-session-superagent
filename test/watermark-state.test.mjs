import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WATERMARK_V2,
  createWatermarkState,
  observe,
  deliver,
  handle,
  mergeWatermarkStates,
  migrateV1Watermark,
} from '../lib/rooms/watermark-state.js'

const AT = '2026-11-21T12:00:00.000Z'

test('状态房：首次 observe 只建立该条基线，不产生交付或处置', () => {
  const empty = createWatermarkState()
  const next = observe(observe(empty, 'issue:1', 'h:one', { round: 1 }), 'issue:2', 20, { round: 2 })
  assert.equal(next.watermarkVersion, WATERMARK_V2)
  assert.equal(next.round, 2)
  assert.deepEqual(next.obs['issue:1'], {
    cursor: 'h:one', delivered: null, handled: null, retries: 0, round: 1,
  })
  assert.deepEqual(next.obs['issue:2'], {
    cursor: 20, delivered: null, handled: null, retries: 0, round: 2,
  })
  assert.deepEqual(empty, { watermarkVersion: WATERMARK_V2, round: 0, obs: {} }, '不得原地修改输入')
})

test('状态房：普通 observe 不推进已有条目的基线，未列条目不会因此被吞', () => {
  const initial = observe(createWatermarkState(), 'issue:131', 'old', { round: 1 })
  const seenAgain = observe(initial, 'issue:131', 'new', { round: 2 })
  assert.equal(seenAgain, initial, '未交付前重复看到新 cursor 不得吞掉它')
  assert.equal(seenAgain.obs['issue:131'].cursor, 'old')
  assert.equal(seenAgain.round, 1)
})

test('状态房：deliver 只写目标行，保留其他条目与各自重试计数', () => {
  let state = observe(createWatermarkState(), 'issue:7', 'a', { round: 1 })
  state = observe(state, 'issue:8', 'b', { round: 2 })
  const before8 = state.obs['issue:8']
  state = deliver(state, 'issue:7', 'a', { round: 3, at: AT })
  assert.deepEqual(state.obs['issue:8'], before8)
  assert.deepEqual(state.obs['issue:7'].delivered, { cursor: 'a', round: 3, at: AT })
  assert.equal(state.obs['issue:7'].retries, 1)
  assert.equal(state.round, 3)
  assert.throws(() => deliver(state, 'issue:7', 'a', { round: 3 }), /round/)
})

test('状态房：同一 cursor 的重提累加次数，新内容重新计数', () => {
  let state = observe(createWatermarkState(), 'issue:7', 'a', { round: 1 })
  state = deliver(state, 'issue:7', 'a', { round: 2, at: AT })
  state = deliver(state, 'issue:7', 'a', { round: 3, at: AT })
  assert.equal(state.obs['issue:7'].retries, 2)
  state = deliver(state, 'issue:7', 'b', { round: 4, at: AT })
  assert.equal(state.obs['issue:7'].retries, 1)
  assert.equal(state.obs['issue:7'].cursor, 'b')
})

test('状态房：handle 对齐该条处置后的 cursor，自清自 ack，不动其他行', () => {
  let state = observe(createWatermarkState(), 'issue:7', 'before', { round: 1 })
  state = observe(state, 'issue:8', 'untouched', { round: 2 })
  state = deliver(state, 'issue:7', 'before', { round: 3, at: AT })
  const other = state.obs['issue:8']
  state = handle(state, 'issue:7', 'after-own-ack', { round: 4, at: AT })
  assert.equal(state.obs['issue:7'].cursor, 'after-own-ack')
  assert.deepEqual(state.obs['issue:7'].handled, { cursor: 'after-own-ack', round: 4, at: AT })
  assert.equal(state.obs['issue:7'].retries, 0)
  assert.deepEqual(state.obs['issue:8'], other)
})

test('状态房：行级合并让旧轮询快照输给新 ack，pending 不会复活', () => {
  let oldPoll = observe(createWatermarkState(), 'issue:7', 'old', { round: 1 })
  oldPoll = deliver(oldPoll, 'issue:7', 'old', { round: 2, at: AT })
  const acked = handle(oldPoll, 'issue:7', 'acked', { round: 3, at: AT })
  const merged = mergeWatermarkStates(acked, oldPoll)
  assert.deepEqual(merged.obs['issue:7'].handled, acked.obs['issue:7'].handled)
  assert.equal(merged.obs['issue:7'].cursor, 'acked')
  assert.equal(merged.round, 3)
})

test('状态房：ack #7 的合并不影响未 ack 的 #8', () => {
  let stored = observe(createWatermarkState(), 'issue:7', 'a', { round: 1 })
  stored = observe(stored, 'issue:8', 'b', { round: 2 })
  stored = handle(stored, 'issue:7', 'ack-a', { round: 3, at: AT })
  let oldPoll = observe(createWatermarkState(), 'issue:7', 'a', { round: 1 })
  oldPoll = observe(oldPoll, 'issue:8', 'b', { round: 2 })
  oldPoll = deliver(oldPoll, 'issue:8', 'b', { round: 4, at: AT })
  const merged = mergeWatermarkStates(stored, oldPoll)
  assert.equal(merged.obs['issue:7'].handled.cursor, 'ack-a')
  assert.equal(merged.obs['issue:8'].delivered.cursor, 'b')
  assert.equal(merged.round, 4)
})

test('状态房：同轮冲突仍保留 handle，且 delivered/handled 各自单调', () => {
  const base = observe(createWatermarkState(), 'issue:7', 'a', { round: 1 })
  const delivered = deliver(base, 'issue:7', 'a', { round: 2, at: AT })
  const handled = handle(base, 'issue:7', 'ack', { round: 2, at: AT })
  const merged = mergeWatermarkStates(delivered, handled)
  assert.equal(merged.obs['issue:7'].delivered.round, 2)
  assert.equal(merged.obs['issue:7'].handled.cursor, 'ack')
  assert.equal(merged.obs['issue:7'].cursor, 'ack')
})

test('状态房：v1 seen/pending/acked 迁移保留含义，幂等且不改输入', () => {
  const legacy = {
    repo: 'o/r', kind: 'issue',
    seen: { 7: '2026-11-20T01:00:00Z', 8: '2026-11-20T02:00:00Z' },
    pending: { 7: { at: '2026-11-20T01:10:00Z', tries: 2 } },
    acked: { 8: { at: '2026-11-20T02:10:00Z' } },
    custom: 'keep-me',
  }
  const migrated = migrateV1Watermark(legacy)
  assert.equal(migrated.watermarkVersion, WATERMARK_V2)
  assert.equal(migrated.custom, 'keep-me')
  assert.equal(migrated.obs['issue:7'].legacy, true)
  assert.equal(migrated.obs['issue:7'].delivered.round < migrated.obs['issue:8'].handled.round, true)
  assert.equal(migrated.obs['issue:7'].retries, 2)
  assert.equal(legacy.watermarkVersion, undefined)
  assert.equal(migrateV1Watermark(migrated), migrated)
  assert.throws(() => migrateV1Watermark({ watermarkVersion: WATERMARK_V2 + 1 }), /newer/)
})

test('状态房：legacy 第一次 v2 observe 对齐当前 cursor，但不丢旧 pending', () => {
  const migrated = migrateV1Watermark({
    kind: 'issue', seen: { 7: 'old' }, pending: { 7: { at: AT, tries: 1 } },
  })
  const aligned = observe(migrated, 'issue:7', 'h:current', { round: migrated.round + 1 })
  assert.equal(aligned.obs['issue:7'].cursor, 'h:current')
  assert.equal(aligned.obs['issue:7'].delivered.cursor, 'h:current')
  assert.equal(aligned.obs['issue:7'].delivered.at, AT)
  assert.equal(aligned.obs['issue:7'].legacy, undefined)
  assert.equal(aligned.obs['issue:7'].retries, 1)
})

test('状态房：随机事件序列满足行轮次与合并不变式', () => {
  let state = createWatermarkState()
  let seed = 42
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 }
  for (let index = 0; index < 200; index += 1) {
    const before = state
    const key = 'issue:' + (1 + Math.floor(random() * 5))
    const cursor = 'h:' + Math.floor(random() * 8)
    const round = state.round + 1
    const choice = Math.floor(random() * 3)
    if (choice === 0) state = observe(state, key, cursor, { round })
    else if (choice === 1) state = deliver(state, key, cursor, { round, at: AT })
    else state = handle(state, key, cursor, { round, at: AT })
    assert.ok(state.round >= before.round)
    for (const row of Object.values(state.obs)) {
      assert.ok(row.round <= state.round)
      if (row.delivered) assert.ok(row.delivered.round <= row.round)
      if (row.handled) assert.ok(row.handled.round <= row.round)
    }
    const merged = mergeWatermarkStates(state, before)
    for (const [rowKey, row] of Object.entries(state.obs)) {
      assert.equal(merged.obs[rowKey].round, row.round)
      if (row.handled) assert.equal(merged.obs[rowKey].handled.round, row.handled.round)
      if (row.delivered) assert.equal(merged.obs[rowKey].delivered.round, row.delivered.round)
    }
  }
})
