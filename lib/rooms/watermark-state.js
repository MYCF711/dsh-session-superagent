/**
 * 水位 v2 · 状态房。
 *
 * 纯函数、无 I/O、不理解 GitHub/Gitee 字段。watcher 的其余配置字段原样保留；
 * 本模块只拥有 watermarkVersion / round / obs 三个键。
 */

export const WATERMARK_V2 = 2

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertKey(key) {
  const text = String(key || '')
  if (!text) throw new TypeError('observation key is required')
  return text
}

function assertCursor(cursor) {
  if (typeof cursor === 'string' && cursor) return cursor
  if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0) return cursor
  throw new TypeError('cursor must be a non-empty string or a non-negative safe integer')
}

function validRound(value, fallback = 0) {
  const round = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(round) || round < 0) throw new TypeError('round must be a non-negative safe integer')
  return round
}

function nextRound(state, requested) {
  const round = requested === undefined ? state.round + 1 : validRound(requested)
  if (round <= state.round) throw new RangeError(`round must advance beyond ${state.round}`)
  return round
}

function asV2(input) {
  if (input && input.watermarkVersion !== undefined) {
    if (input.watermarkVersion !== WATERMARK_V2) {
      throw new Error(`watermarkVersion ${input.watermarkVersion} is newer than supported ${WATERMARK_V2}`)
    }
    return input
  }
  return createWatermarkState(input)
}

function eventAt(options) {
  return options.at === undefined ? new Date().toISOString() : String(options.at)
}

function cloneEvent(event) {
  return event ? { ...event } : null
}

function cloneRow(row) {
  return {
    ...row,
    delivered: cloneEvent(row.delivered),
    handled: cloneEvent(row.handled),
  }
}

/** 建立空 v2 状态；调用方传入的其他 watcher 字段原样保留。 */
export function createWatermarkState(fields = {}) {
  const source = isObject(fields) ? fields : {}
  return {
    ...source,
    watermarkVersion: WATERMARK_V2,
    round: validRound(source.round),
    obs: isObject(source.obs) ? { ...source.obs } : {},
  }
}

/**
 * 只建立/对齐条目基线。已有正常行不推进 cursor：观察到 ≠ 已交付，
 * 否则「另有 N 条」里的条目会在下一轮被自己的观察记录吞掉。
 */
export function observe(input, key, cursor, options = {}) {
  const state = asV2(input)
  const rowKey = assertKey(key)
  const position = assertCursor(cursor)
  const previous = state.obs[rowKey]
  if (previous && !previous.legacy) return state

  const round = nextRound(state, options.round)
  let row
  if (!previous) {
    row = { cursor: position, delivered: null, handled: null, retries: 0, round }
  } else {
    row = {
      ...cloneRow(previous),
      cursor: position,
      round,
    }
    if (row.delivered) row.delivered.cursor = position
    if (row.handled) row.handled.cursor = position
    delete row.legacy
  }
  return { ...state, round, obs: { ...state.obs, [rowKey]: row } }
}

/** 只有交付房收到成功回执后才能调用。 */
export function deliver(input, key, cursor, options = {}) {
  const state = asV2(input)
  const rowKey = assertKey(key)
  const position = assertCursor(cursor)
  const round = nextRound(state, options.round)
  const previous = state.obs[rowKey] || { cursor: position, delivered: null, handled: null, retries: 0 }
  const sameDelivery = previous.delivered && previous.delivered.cursor === position
  const row = {
    ...cloneRow(previous),
    cursor: position,
    delivered: { cursor: position, round, at: eventAt(options) },
    retries: sameDelivery ? (Number(previous.retries) || 0) + 1 : 1,
    round,
  }
  delete row.legacy
  return { ...state, round, obs: { ...state.obs, [rowKey]: row } }
}

/** 只有处置成功后才能调用；cursor 应是处置完成后的上游位置。 */
export function handle(input, key, cursor, options = {}) {
  const state = asV2(input)
  const rowKey = assertKey(key)
  const position = assertCursor(cursor)
  const round = nextRound(state, options.round)
  const previous = state.obs[rowKey] || { delivered: null, handled: null, retries: 0 }
  const row = {
    ...cloneRow(previous),
    cursor: position,
    handled: { cursor: position, round, at: eventAt(options) },
    retries: 0,
    round,
  }
  delete row.legacy
  return { ...state, round, obs: { ...state.obs, [rowKey]: row } }
}

function latestEvent(left, right) {
  if (!left) return cloneEvent(right)
  if (!right) return cloneEvent(left)
  const leftRound = validRound(left.round)
  const rightRound = validRound(right.round)
  if (leftRound !== rightRound) return cloneEvent(leftRound > rightRound ? left : right)
  const leftAt = Date.parse(String(left.at || ''))
  const rightAt = Date.parse(String(right.at || ''))
  if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
    return cloneEvent(leftAt > rightAt ? left : right)
  }
  return cloneEvent(right)
}

function mergeRow(left, right) {
  if (!left) return cloneRow(right)
  if (!right) return cloneRow(left)
  const leftRound = validRound(left.round)
  const rightRound = validRound(right.round)
  let source
  if (leftRound !== rightRound) source = leftRound > rightRound ? left : right
  else {
    // 同轮冲突可能来自两个实例同时基于同一快照写入。处置记录优先于普通观察，
    // 避免「轮次相同」成为丢失 ack 的洞。
    const leftHandled = Number(left.handled && left.handled.round) || 0
    const rightHandled = Number(right.handled && right.handled.round) || 0
    if (leftHandled !== rightHandled) source = leftHandled > rightHandled ? left : right
    else source = right
  }
  const row = {
    ...cloneRow(source),
    delivered: latestEvent(left.delivered, right.delivered),
    handled: latestEvent(left.handled, right.handled),
    round: Math.max(leftRound, rightRound),
  }
  return row
}

/**
 * 行级 LWW：配置以 stored 为准，obs 取两边并集；旧快照不能抹掉新处置。
 * delivered/handled 再按各自 round 取新，覆盖两个实例同轮写入的边界。
 */
export function mergeWatermarkStates(stored, polled) {
  const left = asV2(stored)
  const right = asV2(polled)
  const obs = {}
  for (const key of new Set([...Object.keys(left.obs || {}), ...Object.keys(right.obs || {})])) {
    obs[key] = mergeRow(left.obs[key], right.obs[key])
  }
  return {
    ...left,
    watermarkVersion: WATERMARK_V2,
    round: Math.max(validRound(left.round), validRound(right.round)),
    obs,
  }
}

function legacyKey(kind, number) {
  return kind === 'pr' ? `pr:${number}/comment` : `issue:${number}`
}

/**
 * v1 → v2 只转换状态，不改变运行时行为。legacy 行第一次被新版观察到时，
 * 由 observe 把上游 cursor 对齐到当前位置，避免字符串时间与新指纹直接比较。
 */
export function migrateV1Watermark(entry = {}) {
  if (entry.watermarkVersion !== undefined) {
    if (entry.watermarkVersion === WATERMARK_V2) return entry
    throw new Error(`watermarkVersion ${entry.watermarkVersion} is newer than supported ${WATERMARK_V2}`)
  }
  const kind = entry.kind === 'pr' ? 'pr' : 'issue'
  const seen = kind === 'pr'
    ? (isObject(entry.seenComments) ? entry.seenComments : {})
    : (isObject(entry.seen) ? entry.seen : {})
  const pending = isObject(entry.pending) ? entry.pending : {}
  const acked = isObject(entry.acked) ? entry.acked : {}
  const lastAcked = isObject(entry.lastAcked) ? entry.lastAcked : {}
  const lastNumbers = new Set((Array.isArray(lastAcked.numbers) ? lastAcked.numbers : []).map(String))
  const numbers = new Set([
    ...Object.keys(seen), ...Object.keys(pending), ...Object.keys(acked), ...lastNumbers,
  ])
  const ordered = [...numbers].sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)))
  const obs = {}
  let round = validRound(entry.round)
  for (const number of ordered) {
    const key = legacyKey(kind, number)
    const pendingRecord = isObject(pending[number]) ? pending[number] : null
    const ackRecord = isObject(acked[number]) ? acked[number] : null
    const seenCursor = seen[number] ?? (pendingRecord && pendingRecord.at) ?? (ackRecord && ackRecord.at) ?? lastAcked.at ?? 'unknown'
    const cursor = `v1:${String(seenCursor)}`
    const row = {
      cursor,
      delivered: null,
      handled: null,
      retries: pendingRecord ? Number(pendingRecord.tries) || 0 : 0,
      round,
      legacy: true,
    }
    if (pendingRecord) {
      round += 1
      row.delivered = { cursor, round, at: String(pendingRecord.at || '') }
      row.round = round
    }
    if (ackRecord || lastNumbers.has(String(number))) {
      round += 1
      row.handled = { cursor, round, at: String((ackRecord && ackRecord.at) || lastAcked.at || '') }
      row.round = round
      row.retries = 0
    }
    obs[key] = row
  }
  return {
    ...entry,
    watermarkVersion: WATERMARK_V2,
    round,
    obs,
  }
}
