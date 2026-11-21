/**
 * 水位 v2 · 决策房。
 *
 * 输入是当前条目与只读 obs 投影，输出分类与本轮批次。无 I/O、无定时器、
 * 不写 delivered/handled；状态提交只能由交付/处置成功后的状态房完成。
 */

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validRecord(record) {
  if (!isObject(record) || !String(record.key || '')) return false
  const cursor = record.cursor
  return (typeof cursor === 'string' && cursor.length > 0)
    || (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0)
}

function eventRound(event) {
  return Number(event && event.round) || 0
}

function eventTime(event) {
  const parsed = Date.parse(String(event && event.at || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function emptyDecision() {
  return {
    fresh: [], retry: [], waiting: [], unchanged: [], handled: [], exhausted: [], baseline: [], invalid: [],
    candidates: [], listed: [], rest: [], deferred: [], capped: false,
    budget: { used: 0, remaining: 0 },
  }
}

/**
 * @param {object} input
 * @param {Array<{key:string,cursor:string|number,item?:object}>} input.items
 * @param {Record<string,object>} input.obs
 * @param {(left:any,right:any)=>boolean} [input.sameCursor]
 */
export function decideWatermark(input = {}) {
  const out = emptyDecision()
  const items = Array.isArray(input.items) ? input.items : []
  const obs = isObject(input.obs) ? input.obs : {}
  const same = typeof input.sameCursor === 'function' ? input.sameCursor : (left, right) => left === right
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()
  const cooldownMs = Math.max(0, Number(input.cooldownMs ?? 10 * 60 * 1000) || 0)
  const maxRetries = Math.max(1, Number(input.maxRetries ?? 2) || 2)
  const batchLimit = Math.max(1, Math.floor(Number(input.batchLimit ?? 5) || 5))

  for (const record of items) {
    if (!validRecord(record)) { out.invalid.push(record); continue }
    const key = String(record.key)
    const row = isObject(obs[key]) ? obs[key] : null
    if (row && row.legacy) { out.baseline.push(record); continue }
    if (!row) { out.fresh.push(record); continue }

    const current = record.cursor
    const delivered = isObject(row.delivered) ? row.delivered : null
    const handled = isObject(row.handled) ? row.handled : null

    // 自己刚完成的 ack 也在这个分支：handled.cursor 已对齐到处置后的位置。
    if (handled && same(current, handled.cursor) && eventRound(handled) >= eventRound(delivered)) {
      out.handled.push(record)
      continue
    }
    if (delivered && same(current, delivered.cursor)) {
      if (handled && eventRound(handled) >= eventRound(delivered)) {
        out.handled.push(record)
      } else if ((Number(row.retries) || 0) >= maxRetries) {
        out.exhausted.push(record)
      } else if (now - eventTime(delivered) < cooldownMs) {
        out.waiting.push(record)
      } else {
        out.retry.push(record)
      }
      continue
    }
    // 只有纯基线行可以判 unchanged。已交付但出现不同 cursor 的行必须落入 fresh，
    // 不能因为 observe 曾见过它就提前消费。
    if (!delivered && !handled && same(current, row.cursor)) out.unchanged.push(record)
    else out.fresh.push(record)
  }

  out.candidates = [...out.fresh, ...out.retry]
  const hourAgo = now - 60 * 60 * 1000
  const wakeTimes = (Array.isArray(input.wakeTimes) ? input.wakeTimes : [])
    .map(Number).filter((at) => Number.isFinite(at) && at >= hourAgo && at <= now)
  const limit = Math.max(0, Number(input.maxWakesPerHour ?? 6) || 0)
  out.budget = { used: wakeTimes.length, remaining: Math.max(0, limit - wakeTimes.length) }
  out.capped = wakeTimes.length >= limit

  if (out.capped) {
    out.deferred = [...out.candidates]
  } else {
    out.listed = out.candidates.slice(0, batchLimit)
    out.rest = out.candidates.slice(batchLimit)
  }
  return out
}
