/** watchers.json schema 迁移：未知未来版本拒绝，失败交给 readState 的 .bak。 */
export const CURRENT_STATE_SCHEMA = 1

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 只增不改地补齐 kind / seenComments；无需变更时保留原引用。 */
export function migratePrWatchers(state) {
  if (!isPlainObject(state) || !isPlainObject(state.watchers)) return state
  let nextWatchers = null
  for (const [key, entry] of Object.entries(state.watchers)) {
    if (!isPlainObject(entry)) continue
    const isPr = key.startsWith('pr:') || entry.kind === 'pr'
    const next = { ...entry }
    if (next.kind === undefined) next.kind = isPr ? 'pr' : 'issue'
    if (isPr && next.seenComments === undefined) next.seenComments = {}
    if (next.kind !== entry.kind || next.seenComments !== entry.seenComments) {
      if (!nextWatchers) nextWatchers = { ...state.watchers }
      nextWatchers[key] = next
    }
  }
  return nextWatchers ? { ...state, watchers: nextWatchers } : state
}

export function migrateState(input) {
  const raw = isPlainObject(input) ? input : {}
  const version = raw.schemaVersion === undefined ? 0 : Number(raw.schemaVersion)
  if (!Number.isInteger(version) || version < 0) throw new Error('invalid state schemaVersion: ' + String(raw.schemaVersion))
  if (version > CURRENT_STATE_SCHEMA) throw new Error('state schemaVersion ' + version + ' is newer than supported ' + CURRENT_STATE_SCHEMA)
  if (version === CURRENT_STATE_SCHEMA) return { state: migratePrWatchers(raw), changed: false, from: version }
  const state = migratePrWatchers({
    ...raw,
    schemaVersion: CURRENT_STATE_SCHEMA,
    watchers: isPlainObject(raw.watchers) ? raw.watchers : {},
  })
  return { state, changed: true, from: version }
}
