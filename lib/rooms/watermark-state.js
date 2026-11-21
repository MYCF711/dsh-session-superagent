/**
 * 水位 v2 · 状态房。
 *
 * 纯函数、无 I/O、不理解 GitHub/Gitee 字段。watcher 的其余配置字段原样保留；
 * 本模块只拥有 watermarkVersion / round / obs 三个键。
 */

// KB: concurrent-isolation.md —— 状态写锁与行级合并的共同约束。
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

export function createWatermarkState(fields = {}) {
  const source = isObject(fields) ? fields : {}
  return {
    ...source,
    watermarkVersion: WATERMARK_V2,
    round: validRound(source.round),
    obs: isObject(source.obs) ? { ...source.obs } : {},
  }
}

export function observe(input, key, cursor, options = {}) {
  const state = asV2(input)
  const rowKey = assertKey(key)
  const position = assertCursor(cursor)
  const previous = state.obs[rowKey]
  if (previous && !previous.legacy && options.force !== true) return state

  const round = nextRound(state, options.round)
  let row
  if (!previous) {
    row = { cursor: position, delivered: null, handled: null, retries: 0, round }
    if (options.force === true) row.observedRound = round
  } else {
    row = {
      ...cloneRow(previous),
      cursor: options.legacyCursor === undefined ? position : assertCursor(options.legacyCursor),
      round,
    }
    const alignedCursor = row.cursor
    if (row.delivered) row.delivered.cursor = alignedCursor
    if (row.handled) row.handled.cursor = alignedCursor
    if (options.force === true) row.observedRound = round
    delete row.legacy
  }
  return { ...state, round, obs: { ...state.obs, [rowKey]: row } }
}

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
  delete row.undelivered
  return { ...state, round, obs: { ...state.obs, [rowKey]: row } }
}

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
  delete row.undelivered
  return { ...state, round, obs: { ...state.obs, [rowKey]: row } }
}

function latestEvent(left, right) {
  if (!left) return cloneEvent(right)
  if (!right) return cloneEvent(left)
  const leftRound = validRound(left.round)
  const rightRound = validRound(right.round)
  if (leftRound !== rightRound) return cloneEvent(leftRound > rightRound ? left : right)
  const leftKey = typeof left.cursor + ':' + String(left.cursor)
  const rightKey = typeof right.cursor + ':' + String(right.cursor)
  return cloneEvent(leftKey >= rightKey ? left : right)
}

function mergeRow(left, right) {
  if (!left) return cloneRow(right)
  if (!right) return cloneRow(left)
  const leftRound = validRound(left.round)
  const rightRound = validRound(right.round)
  let source
  if (leftRound !== rightRound) source = leftRound > rightRound ? left : right
  else {
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
  const deliveredRound = Number(row.delivered && row.delivered.round) || 0
  const handledRound = Number(row.handled && row.handled.round) || 0
  const winningEvent = row.handled && handledRound >= deliveredRound ? row.handled : row.delivered
  const winningRound = Math.max(deliveredRound, handledRound)
  if (winningEvent && winningRound >= row.round) row.cursor = winningEvent.cursor
  if (row.delivered) {
    delete row.undelivered
    if (row.handled && handledRound >= deliveredRound) {
      row.retries = 0
    } else {
      const matches = [left, right].filter((candidate) => candidate.delivered
        && candidate.delivered.cursor === row.delivered.cursor
        && (Number(candidate.delivered.round) || 0) === deliveredRound)
      row.retries = matches.length > 0 ? Math.max(...matches.map((candidate) => Number(candidate.retries) || 0)) : 0
    }
  }
  return row
}

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
    if (kind === 'pr' && seen[number] !== undefined && !pendingRecord) {
      round += 1
      row.delivered = { cursor, round, at: String(entry.lastWake || entry.lastPoll || '') }
      row.round = round
    }
    if (pendingRecord) {
      round += 1
      if ((Number(pendingRecord.tries) || 0) === 0) {
        row.undelivered = true
      } else {
        row.delivered = { cursor, round, at: String(pendingRecord.at || '') }
      }
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
    v1Migrated: true,
  }
}
