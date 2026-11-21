/**
 * 水位 v2 · 交付房。
 *
 * 发送与状态提交之间的唯一事务边界：没有明确成功回执，就不写 delivered；
 * ack 没有处置后的 cursor，就不写 handled。其余房间不得绕过这里直接记账。
 */
import { deliver as commitDelivered, handle as commitHandled } from './watermark-state.js'

function errorText(error) {
  return String(error && error.message || error || 'unknown error').slice(0, 240)
}

function atTime(value) {
  return value === undefined ? new Date().toISOString() : String(value)
}

export async function deliverBatch({ state, listed = [], send, at } = {}) {
  const batch = Array.isArray(listed) ? listed.filter(Boolean) : []
  if (batch.length === 0) return { status: 'empty', state, deliveredKeys: [], ignoredKeys: [] }
  if (typeof send !== 'function') throw new TypeError('deliverBatch requires send')

  let receipt
  try { receipt = await send(batch) } catch (error) {
    return { status: 'failed', state, error: errorText(error), deliveredKeys: [], ignoredKeys: [] }
  }
  if (!receipt || receipt.ok !== true) {
    return {
      status: receipt && receipt.busy === true ? 'busy' : 'failed',
      state,
      error: errorText(receipt && receipt.error || 'delivery was not acknowledged'),
      deliveredKeys: [], ignoredKeys: [],
    }
  }

  const byKey = new Map(batch.map((record) => [String(record.key), record]))
  const requested = receipt.deliveredKeys === undefined
    ? [...byKey.keys()]
    : (Array.isArray(receipt.deliveredKeys) ? receipt.deliveredKeys.map(String) : [])
  const deliveredKeys = []
  const ignoredKeys = []
  const seen = new Set()
  for (const key of requested) {
    if (seen.has(key)) continue
    seen.add(key)
    if (!byKey.has(key)) { ignoredKeys.push(key); continue }
    deliveredKeys.push(key)
  }
  if (deliveredKeys.length === 0) {
    return { status: 'failed', state, error: 'no valid delivered keys in receipt', deliveredKeys, ignoredKeys }
  }

  let next = state
  const atIso = atTime(at)
  for (const key of deliveredKeys) {
    const record = byKey.get(key)
    next = commitDelivered(next, key, record.cursor, { round: next.round + 1, at: atIso })
  }
  return { status: 'delivered', state: next, deliveredKeys, ignoredKeys }
}

export async function acknowledgeBatch({ state, items = [], acknowledge, at } = {}) {
  const batch = Array.isArray(items) ? items.filter(Boolean) : []
  if (typeof acknowledge !== 'function' && batch.length > 0) throw new TypeError('acknowledgeBatch requires acknowledge')
  let next = state
  const results = []
  const atIso = atTime(at)

  for (const record of batch) {
    const key = String(record.key)
    let receipt
    try {
      receipt = await acknowledge({ ...record, ...(record.context || {}) })
    } catch (error) {
      results.push({ key, ok: false, error: errorText(error) })
      continue
    }
    if (!receipt || receipt.ok !== true) {
      results.push({ key, ok: false, error: errorText(receipt && receipt.error || 'ack was not acknowledged') })
      continue
    }
    const postCursor = receipt.cursor
    const validCursor = (typeof postCursor === 'string' && postCursor)
      || (typeof postCursor === 'number' && Number.isSafeInteger(postCursor) && postCursor >= 0)
    if (!validCursor) {
      results.push({ key, ok: false, error: 'ack receipt must include post-ack cursor' })
      continue
    }
    next = commitHandled(next, key, postCursor, { round: next.round + 1, at: atIso })
    results.push({ key, ok: true, cursor: postCursor })
  }
  return { state: next, results }
}
