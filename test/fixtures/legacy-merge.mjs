// 旧 seen/pending 合并算法，仅供历史用例；生产使用 obs 行合并。
import { mergePollResult as mergeV2 } from '../../lib/watch.js'

export function mergeLegacyPollResult(stored, polled) {
  const merged = mergeV2(stored, polled)
  if (!stored || !polled) return merged
  if (stored.seen && polled.seen) {
    const seen = { ...polled.seen }
    for (const [key, at] of Object.entries(stored.seen)) {
      if (!seen[key] || Date.parse(at) > Date.parse(seen[key])) seen[key] = at
    }
    merged.seen = seen
  }
  if (stored.lastPoll && merged.lastPoll && Date.parse(stored.lastPoll) > Date.parse(merged.lastPoll)) merged.lastPoll = stored.lastPoll

  const pending = { ...(polled.pending && typeof polled.pending === 'object' ? polled.pending : {}) }
  for (const [key, record] of Object.entries(stored.pending && typeof stored.pending === 'object' ? stored.pending : {})) {
    const at = Date.parse(String(record && record.at))
    const previousAt = Date.parse(String(pending[key] && pending[key].at))
    if (!pending[key] || (Number.isFinite(at) && (!Number.isFinite(previousAt) || at > previousAt))) pending[key] = record
  }
  const acked = merged.acked && typeof merged.acked === 'object' ? merged.acked : {}
  const lastNumbers = new Set(Array.isArray(merged.lastAcked && merged.lastAcked.numbers) ? merged.lastAcked.numbers.map(String) : [])
  const lastAt = Date.parse(String((merged.lastAcked && merged.lastAcked.at) || ''))
  for (const [key, record] of Object.entries(pending)) {
    const at = Date.parse(String(record && record.at))
    const ownAt = Date.parse(String(acked[key] && acked[key].at))
    const ackAt = Number.isFinite(ownAt) ? ownAt : (lastNumbers.has(String(key)) ? lastAt : NaN)
    if (Number.isFinite(at) && Number.isFinite(ackAt) && at <= ackAt) delete pending[key]
  }
  merged.pending = pending
  return merged
}
