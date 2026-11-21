/**
 * 水位 v2 · 调度房。
 *
 * 只回答「现在是否轮询」：interval、boot、退避、暂停恢复、人工立即与 inFlight。
 * 不读取 obs，也不判断条目是否新鲜。定时器与 poll 都可注入，测试无需真实等待。
 */
export function createWatchScheduler(options = {}) {
  if (typeof options.poll !== 'function') throw new TypeError('createWatchScheduler requires poll')
  const timers = options.timers || globalThis
  const now = typeof options.now === 'function' ? options.now : Date.now
  const noPoll = typeof options.noPoll === 'function' ? options.noPoll : () => false
  const intervalMs = Math.max(30, Number(options.intervalMs) || 60000)
  const bootDelayMs = Math.max(0, Number(options.bootDelayMs) || 0)

  let enabled = options.enabled !== false
  let nextAt = null
  let consecutiveFailures = 0
  let deferReason = null
  let inFlight = false
  let current = null
  let intervalTimer = null
  let bootTimer = null

  const clearIntervalTimer = () => {
    if (intervalTimer) timers.clearInterval(intervalTimer)
    intervalTimer = null
  }
  const clearBootTimer = () => {
    if (bootTimer) timers.clearTimeout(bootTimer)
    bootTimer = null
  }
  const clearBackoff = () => {
    nextAt = null
    consecutiveFailures = 0
    deferReason = null
  }
  const recordFailure = ({ timeout = false } = {}) => {
    if (timeout) {
      nextAt = now() + 30000
      deferReason = 'timeout'
      return
    }
    consecutiveFailures += 1
    const delay = Math.min(30000 * (2 ** Math.max(0, consecutiveFailures - 1)), 30 * 60 * 1000)
    nextAt = now() + delay
    deferReason = 'backoff'
  }
  const run = (manual = false) => {
    if (!enabled) return { status: 'paused' }
    if (inFlight) return { status: 'in-flight' }
    if (noPoll()) return { status: 'offline' }
    if (!manual && nextAt !== null && now() < nextAt) return { status: 'backoff' }
    if (manual) clearBackoff()

    inFlight = true
    current = Promise.resolve()
      .then(() => options.poll({ manual }))
      .then((result) => {
        if (result && result.timeout) recordFailure({ timeout: true })
        else if (result && result.ok === false) recordFailure()
        else clearBackoff()
        return result
      })
      .catch((error) => {
        recordFailure({ timeout: Boolean(error && error.timeout) })
        return { ok: false, error }
      })
      .finally(() => { inFlight = false })
    return { status: 'started' }
  }
  const start = () => {
    if (!enabled) return { status: 'paused' }
    if (noPoll()) return { status: 'offline' }
    if (intervalTimer) return { status: 'already-started' }
    intervalTimer = timers.setInterval(() => { run(false) }, intervalMs)
    if (typeof intervalTimer.unref === 'function') intervalTimer.unref()
    if (bootDelayMs > 0) {
      bootTimer = timers.setTimeout(() => { bootTimer = null; run(false) }, bootDelayMs)
      if (typeof bootTimer.unref === 'function') bootTimer.unref()
    } else {
      run(false)
    }
    return { status: 'started' }
  }
  const pause = () => {
    enabled = false
    clearIntervalTimer()
    clearBootTimer()
    return { status: 'paused' }
  }
  const resume = () => {
    enabled = true
    start()
    const result = run(true)
    if (result.status === 'started') clearBootTimer()
    return result
  }

  return {
    start,
    pause,
    resume,
    stop: pause,
    run,
    pollNow: () => run(true),
    whenIdle: () => current || Promise.resolve(),
    clearBackoff,
    recordFailure,
    status: () => ({
      enabled,
      nextAt,
      consecutiveFailures,
      deferReason,
      inFlight,
      timerPending: Boolean(intervalTimer),
      bootTimerPending: Boolean(bootTimer),
    }),
  }
}
