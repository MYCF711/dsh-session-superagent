import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir } from './fixtures/tmpdir.mjs'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-wake-queue-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_WAKE_WINDOW_MS = '5'
process.env.DSH_SUPERAGENT_WAKE_QUEUE_RETRY_MS = '1000'

const { __test, apply } = await import('../lib/index.js')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeCtx(agent) {
  return {
    tools: { register: () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => ({ id: 's1' }), get: () => agent },
    get: () => null,
    effect: (fn) => fn(),
    inject: () => {},
    on() {},
  }
}

test.afterEach(() => __test.clearWakeQueues())

test('忙时进入 FIFO，空闲后按顺序送达；送达前回调不是成功', async () => {
  const sent = []
  const agent = { status: 'running', followup: (msg) => sent.push(msg.content[0].text) }
  const ctx = makeCtx(agent)
  apply(ctx)
  const first = []
  const second = []
  __test.wakeMerged(ctx, 's1', '第一条', (r) => first.push(r), 'k1')
  await wait(25)
  __test.wakeMerged(ctx, 's1', '第二条', (r) => second.push(r), 'k2')
  await wait(25)

  assert.equal(sent.length, 0, '忙时不能真正调用 followup')
  assert.equal(__test.wakeQueueCount('s1', ctx), 2)
  assert.equal(first[0].ok, false, '入队不等于已送达')
  assert.equal(first[0].queued, true)
  assert.match(first[0].reason, /busy/)

  agent.status = 'idle'
  // flushWakeQueue 是 async 的：await 之后再等合并窗口（WAKE_WINDOW_MS=5）到期才真正 followup。
  await __test.flushWakeQueue(ctx, 's1')
  await wait(20)
  assert.deepEqual(sent, ['第一条'])
  assert.equal(__test.wakeQueueCount('s1', ctx), 1)
  await __test.flushWakeQueue(ctx, 's1')
  await wait(20)
  assert.deepEqual(sent, ['第一条', '第二条'], '必须保持 FIFO 顺序')
  assert.equal(__test.wakeQueueCount('s1', ctx), 0)
  assert.equal(first[1].ok, true, '真正发送后才回调成功')
  assert.equal(second[1].ok, true)
})

test('同一事件重复轮询只排一次，不同事件不会互相吞掉', async () => {
  const agent = { status: 'running', followup: () => { throw new Error('不该发送') } }
  const ctx = makeCtx(agent)
  __test.wakeMerged(ctx, 's1', '同一事件', () => {}, 'same-key')
  await wait(25)
  __test.wakeMerged(ctx, 's1', '同一事件', () => {}, 'same-key')
  await wait(25)
  assert.equal(__test.wakeQueueCount('s1', ctx), 1, '相同 queueKey 不能重复排队')
  __test.wakeMerged(ctx, 's1', '另一个事件', () => {}, 'other-key')
  await wait(25)
  assert.equal(__test.wakeQueueCount('s1', ctx), 2)
})

test('新实例不会误送旧实例的队列', async () => {
  const sent = []
  const oldCtx = makeCtx({ status: 'running', followup: () => {} })
  __test.wakeMerged(oldCtx, 's1', '旧实例消息', () => {}, 'old')
  await wait(25)
  const newCtx = makeCtx({ status: 'idle', followup: (msg) => sent.push(msg.content[0].text) })
  __test.wakeMerged(newCtx, 's1', '新实例消息', () => {}, 'new')
  await wait(25)
  assert.deepEqual(sent, ['新实例消息'], '新实例只发自己的消息')
  assert.equal(__test.wakeQueueCount('s1', oldCtx), 1, '旧实例队列保持独立')
  assert.equal(__test.wakeQueueCount('s1', newCtx), 0)
})

test('并发 flush 只发送一次、只结算一次（review 新 high）', async () => {
  const sent = []
  let settledCalls = 0
  const agent = { status: 'running', followup: (msg) => sent.push(msg.content[0].text) }
  const ctx = makeCtx(agent)
  apply(ctx)
  // 结算回调会先收到一次 ok:false（入队），再收到一次 ok:true（真正送达）；
  // 重复发送时 ok:true 会有两次，所以只数成功的那次。
  __test.wakeMerged(ctx, 's1', '第一条', (r) => { if (r && r.ok === true) settledCalls += 1 }, 'k1')
  await wait(25)
  assert.equal(__test.wakeQueueCount('s1', ctx), 1)

  agent.status = 'idle'
  // timer 触发的 flush 与 poll 触发的 flush 可以同时 in-flight；两次都读同一个
  // queue.items[0] 就会重复发送、重复结算（review 实证 sent=2 / successfulSettlements=2）。
  const p1 = __test.flushWakeQueue(ctx, 's1')
  const p2 = __test.flushWakeQueue(ctx, 's1')
  assert.equal(p1, p2, '第二次 flush 必须复用同一个 Promise，不能各自读队首')
  await Promise.all([p1, p2])
  await wait(20)

  assert.deepEqual(sent, ['第一条'], '只允许真正发送一次')
  assert.equal(settledCalls, 1, '只允许结算一次')
  assert.equal(__test.wakeQueueCount('s1', ctx), 0)
})

test('busy 结算不写 lastError（review medium）', async () => {
  const { planWakeSettlement } = await import('../lib/watch.js')
  const entry = { lastWakeCount: 2 }
  const out = planWakeSettlement(entry, {
    ok: false,
    reason: '还有 1 个子任务在跑 —— 等它们结束，这轮会自动顺延',
    busy: true,
    fresh: [{ number: 7, updated_at: '2026-11-13T00:00:00.000Z' }],
    baseMs: 60000,
  })
  assert.equal(out.error, null, '正常排队不是故障：不能写进 lastError')
  assert.equal(out.deferReason, 'busy')
  assert.equal(out.bumpBackoff, false, 'busy 不能退避')
  assert.equal(out.lastWakeCount, 2, '保留上一批成功唤醒的条数')
})
