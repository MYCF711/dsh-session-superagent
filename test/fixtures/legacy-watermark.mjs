// 仅供旧用例/迁移对照，不在发布包内。生产轮询使用 lib/rooms/*。
export function partitionItems(items, state = {}, options = {}) {
  const { now = Date.now(), cooldownMs = 0 } = options
  if (!Array.isArray(items)) return { fresh: [], absorbed: [] }
  const seen = state.seen ?? {}
  const reported = state.lastReported ?? {}
  const floor = state.cursor ? Date.parse(state.cursor) : 0
  const fresh = []
  const absorbed = []
  for (const item of items) {
    const key = String(item.number)
    const baseline = seen[key] ? Date.parse(seen[key]) : floor
    if (!(Date.parse(item.updated_at) > baseline)) continue
    const handledAt = reported[key]
    if (cooldownMs > 0 && handledAt && now - handledAt < cooldownMs) absorbed.push(item)
    else fresh.push(item)
  }
  return { fresh, absorbed }
}

export function splitFresh(items, state = {}, options = {}) {
  return partitionItems(items, state, options).fresh
}

export function recordPendingWake(pending, numbers, at = new Date().toISOString(), options = {}) {
  const map = { ...(pending && typeof pending === 'object' ? pending : {}) }
  const countTries = options.countTries !== false
  for (const n of numbers || []) {
    const key = String(n)
    const prev = map[key]
    map[key] = { first: (prev && prev.first) || at, at, tries: ((prev && prev.tries) || 0) + (countTries ? 1 : 0) }
  }
  return map
}

export function clearPending(pending, numbers) {
  const map = { ...(pending && typeof pending === 'object' ? pending : {}) }
  for (const n of numbers || []) delete map[String(n)]
  return map
}

export function pendingRetry(pending, items, options = {}) {
  const { maxTries = 2, cooldownMs = 10 * 60 * 1000, now = Date.now() } = options
  const map = pending && typeof pending === 'object' ? pending : {}
  const byNumber = new Map((items || []).map((item) => [String(item && item.number), item]))
  const retry = []
  const stillPending = { ...map }
  for (const [key, record] of Object.entries(map)) {
    const item = byNumber.get(key)
    if (!item) continue
    if (item.state && item.state !== 'open') { delete stillPending[key]; continue }
    const tries = Number(record && record.tries) || 0
    if (tries >= maxTries) { delete stillPending[key]; continue }
    const at = Date.parse(String((record && record.at) || ''))
    if (Number.isFinite(at) && now - at < cooldownMs) continue
    retry.push({ ...item, retryOf: { tries, first: record && record.first, at: record && record.at } })
  }
  return { retry, stillPending }
}

export function advanceSeen(seen, fresh) {
  const next = { ...(seen ?? {}) }
  for (const item of fresh ?? []) next[String(item.number)] = item.updated_at
  return next
}

export function recordReported(state, fresh, now = Date.now(), options = {}) {
  const maxAgeMs = Number(options.maxAgeMs) || 24 * 3600 * 1000
  const maxEntries = Number(options.maxEntries) || 200
  const next = {}
  for (const [key, at] of Object.entries(state.lastReported ?? {})) {
    const time = Number(at)
    if (Number.isFinite(time) && now - time <= maxAgeMs) next[key] = time
  }
  for (const item of fresh ?? []) next[String(item.number)] = now
  return Object.fromEntries(Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, maxEntries))
}

export function newestUpdatedAt(fresh) {
  let newest = null
  for (const item of fresh || []) {
    const at = item.updated_at || item.updatedAt
    if (!at) continue
    if (!newest || Date.parse(at) > Date.parse(newest)) newest = at
  }
  return newest
}

export function pruneSeen(seen, options = {}) {
  const { maxEntries = 200, maxAgeMs = 30 * 24 * 3600 * 1000, now = Date.now() } = options
  const entries = Object.entries(seen && typeof seen === 'object' ? seen : {})
    .filter(([, at]) => {
      const time = Date.parse(String(at))
      return Number.isFinite(time) && now - time <= maxAgeMs
    })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, maxEntries)
  return Object.fromEntries(entries.map(([key, value]) => [key, new Date(value).toISOString()]))
}

export function pushAbsorbed(list, items, at, max = 5) {
  const next = Array.isArray(list) ? list.slice() : []
  for (const item of items || []) next.push({ at, number: item.number, title: String(item.title || '').slice(0, 80) })
  return next.slice(-Math.max(1, Number(max) || 20))
}

export function silentStreak({ previousWakeAt, lastAckedAt, previousStreak = 0 } = {}) {
  if (!previousWakeAt) return 0
  if (lastAckedAt && Date.parse(lastAckedAt) >= Date.parse(previousWakeAt)) return 0
  return (Number(previousStreak) || 0) + 1
}

export function bumpDailyWakes(daily, atIso = new Date().toISOString(), keepDays = 7) {
  const day = String(atIso).slice(0, 10)
  const map = (daily && typeof daily === 'object' && !Array.isArray(daily)) ? { ...daily } : {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return map
  map[day] = (Number(map[day]) || 0) + 1
  return Object.fromEntries(Object.keys(map).sort().slice(-Math.max(1, Number(keepDays) || 7)).map((key) => [key, map[key]]))
}

export function pruneCommentSeen(seen, openNumbers) {
  const open = new Set((Array.isArray(openNumbers) ? openNumbers : []).map(String))
  const out = {}
  for (const [key, value] of Object.entries(seen && typeof seen === 'object' ? seen : {})) {
    if (open.has(String(key))) out[key] = Number(value) || 0
  }
  return out
}

export function advanceCommentSeen(seen, updates) {
  const out = {}
  for (const [key, value] of Object.entries(seen && typeof seen === 'object' ? seen : {})) out[key] = Number(value) || 0
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || update.number === undefined || update.number === null) continue
    const latest = Number(update.latestId)
    if (!Number.isFinite(latest)) continue
    const key = String(update.number)
    const previous = Number(out[key])
    if (!Number.isFinite(previous) || latest > previous) out[key] = latest
  }
  return out
}
