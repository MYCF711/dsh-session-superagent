/**
 * 水位 v2 · 投影房。
 *
 * 面板、工具与诊断共用只读视图。输入不被修改，输出冻结；内部 obs 表不暴露，
 * 因此 UI 不能绕过状态房回写水位。
 */
import { decideWatermark } from './watermark-decision.js'
import { isWatcherEnabled } from '../enabled.js'

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function timeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function latest(rows, field) {
  let latestAt = null
  let latestValue = 0
  for (const row of rows) {
    const event = row && row[field]
    if (!event) continue
    const value = timeValue(event.at)
    if (value >= latestValue) { latestValue = value; latestAt = event.at || null }
  }
  return latestAt
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export function projectWatcher(entry, options = {}) {
  const source = isObject(entry) ? entry : {}
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  // 必须走全仓唯一的判据：`enabled: 'off' / 0 / 'no'` 也算暂停。
  // 以前这里是 `source.enabled !== false`，于是 `watch_status` 公开 JSON 里
  // `enabled: true` 与 `pollHealth()` 的 `paused` 自相矛盾（PR #68 review 第 4 条）。
  const enabled = isWatcherEnabled(source)
  const nextAt = source.nextAt || null
  const status = !enabled ? 'paused'
    : source.lastError ? 'error'
      : (nextAt && timeValue(nextAt) > now) ? 'deferred'
        : 'running'
  const version = Number(source.watermarkVersion) || 1
  const obs = isObject(source.obs) ? source.obs : {}
  const rows = Object.values(obs).filter(isObject)
  const legacyPending = isObject(source.pending) ? Object.keys(source.pending) : []

  const hasCurrentItems = Array.isArray(options.items)
  let decision = null
  if (version === 2) {
    decision = decideWatermark({
      items: Array.isArray(options.items) ? options.items : [],
      obs,
      sameCursor: options.sameCursor,
      now,
      cooldownMs: options.cooldownMs,
      maxRetries: options.maxRetries,
      batchLimit: options.batchLimit,
      wakeTimes: source.wakeTimes,
      maxWakesPerHour: source.maxWakesPerHour,
    })
  }

  const knownState = Object.keys(source).length > 0
  const freshCount = knownState && hasCurrentItems && decision ? decision.fresh.length : (knownState && version === 1 ? 0 : null)
  const retryCount = knownState && hasCurrentItems && decision ? decision.retry.length : (knownState && version === 1 ? legacyPending.length : null)
  const handledCount = knownState && hasCurrentItems && decision ? decision.handled.length : (knownState && version === 1 ? (isObject(source.acked) ? Object.keys(source.acked).length : 0) : null)
  const candidateCount = knownState && hasCurrentItems && decision ? decision.candidates.length : (knownState && version === 1 ? legacyPending.length : null)
  const legacyCount = version === 1 ? legacyPending.length : rows.filter((row) => row.legacy).length

  return deepFreeze({
    id: source.id || null,
    repo: source.repo || null,
    sessionId: source.sessionId || null,
    kind: source.kind || 'issue',
    enabled,
    status,
    watermarkVersion: version,
    round: Number(source.round) || 0,
    freshCount,
    retryCount,
    handledCount,
    candidateCount,
    legacyCount,
    lastDeliveryAt: latest(rows, 'delivered'),
    lastHandledAt: latest(rows, 'handled'),
    lastError: source.lastError || null,
    nextAt,
    deferReason: source.deferReason || null,
    capabilities: Array.isArray(options.capabilities) ? [...options.capabilities] : [],
    budget: decision ? decision.budget : { used: 0, remaining: 0 },
  })
}

export function projectWatchers(state, options = {}) {
  const watchers = isObject(state && state.watchers) ? state.watchers : {}
  const itemsById = isObject(options.itemsById) ? options.itemsById : {}
  return deepFreeze(Object.entries(watchers).map(([id, entry]) => projectWatcher(
    { id, ...(isObject(entry) ? entry : {}) },
    { ...options, items: itemsById[id] || options.items || [] },
  )))
}
