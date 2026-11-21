// 旧唤醒结算，仅供历史用例；生产使用 lib/watch.js 的 v2 结算。
import { advanceSeen, recordReported, newestUpdatedAt } from './legacy-watermark.mjs'
import { silentStreak, bumpDailyWakes, pushHistory } from '../../lib/watch.js'

export function planWakeSettlement(entry, { ok, reason, busy: busyFlag = false, fresh = [], listed = fresh, firstSync = false, baseMs = 60000, now = Date.now() } = {}) {
  const at = new Date(now).toISOString()
  const numbers = (fresh || []).map((item) => item && item.number).filter(Boolean)
  const oldest = (fresh || []).map((item) => Date.parse(String((item && (item.updated_at || item.updatedAt)) || ''))).filter((time) => Number.isFinite(time)).sort((a, b) => a - b)[0]
  const history = pushHistory(entry.history, {
    at, numbers, ok: Boolean(ok), reason: ok ? null : String(reason || '').slice(0, 120),
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
  })
  const lastWake = ok ? at : 'failed: ' + String(reason || '')
  if (!ok) {
    const busy = busyFlag === true || /busy|running|idle/i.test(String(reason || ''))
    return {
      lastWake, history, lastBatch: numbers, lastWakeCount: Number(entry.lastWakeCount) || 0,
      commitEtag: false, advanceWatermark: false, deferReason: 'busy',
      lastDeferred: busy ? '会话正忙，下一轮重试' : (entry.lastDeferred || null),
      bumpBackoff: !busy, baseMs, error: busy ? null : 'wake: ' + String(reason || ''),
    }
  }
  return {
    lastWake, history, lastBatch: numbers, lastWakeCount: (fresh || []).length,
    commitEtag: (fresh || []).length > 0,
    advanceWatermark: (fresh || []).length > 0,
    seen: advanceSeen(entry.seen, listed || []),
    lastReported: recordReported(entry, listed || []),
    cursor: (fresh || []).length > 0 && (listed || []).length >= (fresh || []).length ? newestUpdatedAt(fresh || []) : (entry.cursor ?? null),
    silentWakes: silentStreak({ previousWakeAt: entry.prevWakeAt, lastAckedAt: entry.lastAcked && entry.lastAcked.at, previousStreak: entry.silentWakes }),
    prevWakeAt: at,
    wakeTimes: [...(entry.wakeTimes || []), now],
    dailyWakes: bumpDailyWakes(entry.dailyWakes, at),
    lastDeferred: null,
    deferReason: null,
    ackedRecovered: Boolean(entry.prevWakeAt && silentStreak({ previousWakeAt: entry.prevWakeAt, lastAckedAt: entry.lastAcked && entry.lastAcked.at, previousStreak: entry.silentWakes }) === 0),
    eventKind: firstSync ? 'baseline' : 'wake',
    eventText: (firstSync ? '首次同步（存量 ' : '唤醒了 ') + numbers.length + ' 条' + (firstSync ? '）' : '') + '：' + numbers.map((n) => '#' + n).join(' '),
    error: null,
  }
}
