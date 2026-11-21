/**
 * 水位 v2 · 投影房。
 *
 * 面板、工具与诊断共用只读视图。输入不被修改，输出冻结；内部 obs 表不暴露，
 * 因此 UI 不能绕过状态房回写水位。
 */
import { decideWatermark } from './watermark-decision.js'

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
  const enabled = source.enabled !== false
  const nextAt = source.nextAt || null
  const status = !enabled ? 'paused'
    : source.lastError ? 'error'
      : (nextAt && timeValue(nextAt) > now) ? 'deferred'
        : 'running'
  const version = Number(source.watermarkVersion) || 1
  const obs = isObject(source.obs) ? source.obs : {}
  const rows = Object.values(obs).filter(isObject)
  const legacyPending = isObject(source.pending) ? Object.keys(source.pending) : []

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

  const freshCount = decision ? decision.fresh.length : 0
  const retryCount = decision ? decision.retry.length : legacyPending.length
  const handledCount = decision ? decision.handled.length : (isObject(source.acked) ? Object.keys(source.acked).length : 0)
  const candidateCount = decision ? decision.candidates.length : legacyPending.length
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
