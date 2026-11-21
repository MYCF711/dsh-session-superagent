import assert from 'node:assert/strict'
import test from 'node:test'

import { createWatchScheduler } from '../lib/rooms/scheduler.js'

function fakeTimers() {
  let id = 0
  const intervals = new Map()
  const timeouts = new Map()
  const handle = (callback) => ({ callback, cleared: false, unref() { return this } })
  return {
    intervals, timeouts,
    setInterval(callback) { const value = handle(callback); intervals.set(++id, value); return value },
    setTimeout(callback) { const value = handle(callback); timeouts.set(++id, value); return value },
    clearInterval(value) { if (value) value.cleared = true },
    clearTimeout(value) { if (value) value.cleared = true },
    fireBoot() {
      for (const [key, value] of timeouts) {
        if (!value.cleared) { timeouts.delete(key); value.callback(); return true }
      }
      return false
    },
  }
}

function setup(overrides = {}) {
  const timers = fakeTimers()
  const calls = []
  let gate = Promise.resolve({ ok: true })
  const scheduler = createWatchScheduler({
    poll: async () => { calls.push(calls.length + 1); return gate },
    timers,
    intervalMs: 60000,
    bootDelayMs: 25,
    now: () => 1000000,
    ...overrides,
  })
  return { scheduler, timers, calls, setGate: (value) => { gate = value } }
}

test('调度房：start 幂等，interval 与 boot 各只有一份', () => {
  const { scheduler, timers } = setup()
  scheduler.start(); scheduler.start()
  assert.equal(timers.intervals.size, 1)
  assert.equal(timers.timeouts.size, 1)
  assert.equal(scheduler.status().timerPending, true)
  assert.equal(scheduler.status().bootTimerPending, true)
})

test('调度房：退避期自动 tick 跳过，人工立即清退避并真执行', async () => {
  const { scheduler, calls } = setup()
  scheduler.recordFailure()
  assert.equal(scheduler.run().status, 'backoff')
  const out = scheduler.pollNow()
  await scheduler.whenIdle()
  assert.equal(out.status, 'started')
  assert.equal(calls.length, 1)
  assert.equal(scheduler.status().nextAt, null)
  assert.equal(scheduler.status().consecutiveFailures, 0)
})

test('调度房：inFlight 期间第二个立即请求不叠轮询', async () => {
  let release
  const { scheduler, calls, setGate } = setup()
  setGate(new Promise((resolve) => { release = () => resolve({ ok: true }) }))
  assert.equal(scheduler.pollNow().status, 'started')
  assert.equal(scheduler.pollNow().status, 'in-flight')
  release()
  await scheduler.whenIdle()
  assert.equal(calls.length, 1)
})

test('调度房：恢复只补跑一轮，撤销 boot 且 interval 仍在', async () => {
  const { scheduler, timers, calls } = setup()
  scheduler.start()
  scheduler.pause()
  // pause 清掉旧 boot；再模拟一个 startWatcher 刚排上的 boot。
  scheduler.start()
  const out = scheduler.resume()
  await scheduler.whenIdle()
  assert.equal(out.status, 'started')
  assert.equal(calls.length, 1)
  assert.equal(scheduler.status().bootTimerPending, false)
  assert.equal(scheduler.status().timerPending, true)
  assert.equal(timers.fireBoot(), false, '不应还有可 fire 的 boot')
})

test('调度房：NO_POLL 挡住人工/自动轮询，也不顺手清退避', async () => {
  const { scheduler, timers, calls } = setup({ noPoll: () => true })
  scheduler.recordFailure()
  const before = scheduler.status().nextAt
  scheduler.start()
  assert.equal(scheduler.pollNow().status, 'offline')
  assert.equal(scheduler.resume().status, 'offline')
  assert.equal(calls.length, 0)
  assert.equal(timers.intervals.size, 0)
  assert.equal(timers.timeouts.size, 0)
  assert.equal(scheduler.status().nextAt, before)
})

test('调度房：超时 30 秒重试不累加失败；普通失败才指数退避', () => {
  const { scheduler } = setup()
  scheduler.recordFailure({ timeout: true })
  assert.equal(scheduler.status().consecutiveFailures, 0)
  assert.equal(scheduler.status().nextAt, 1030000)
  assert.equal(scheduler.status().deferReason, 'timeout')
  scheduler.clearBackoff()
  scheduler.recordFailure()
  assert.equal(scheduler.status().nextAt, 1030000)
  scheduler.recordFailure()
  assert.equal(scheduler.status().consecutiveFailures, 2)
  assert.equal(scheduler.status().nextAt, 1060000)
})

test('调度房：成功结果清退避与失败计数', async () => {
  const { scheduler } = setup()
  scheduler.recordFailure()
  scheduler.pollNow()
  await scheduler.whenIdle()
  assert.equal(scheduler.status().consecutiveFailures, 0)
  assert.equal(scheduler.status().nextAt, null)
  assert.equal(scheduler.status().deferReason, null)
})

test('调度房：pause 后不再启动新轮询，stop 清掉两类定时器', async () => {
  const { scheduler, timers, calls } = setup()
  scheduler.start(); scheduler.pause()
  assert.equal(scheduler.run().status, 'paused')
  assert.equal(calls.length, 0)
  assert.equal([...timers.intervals.values()].every((timer) => timer.cleared), true)
  assert.equal([...timers.timeouts.values()].every((timer) => timer.cleared), true)
  scheduler.stop()
  assert.equal(scheduler.status().timerPending, false)
  assert.equal(scheduler.status().bootTimerPending, false)
})

test('调度房：boot fire 只执行一次并清除 pending', async () => {
  const { scheduler, timers, calls } = setup()
  scheduler.start()
  assert.equal(timers.fireBoot(), true)
  await scheduler.whenIdle()
  assert.equal(timers.fireBoot(), false)
  assert.equal(calls.length, 1)
  assert.equal(scheduler.status().bootTimerPending, false)
})
