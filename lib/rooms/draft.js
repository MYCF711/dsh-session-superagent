/**
 * 单人设置草稿状态。
 *
 * 只维护 base/value/revision 与 clean/editing 两态；保存、持久化和并发合并由调用方负责。
 * 所有转换都复制输入并返回深冻结的新对象，调用方不能通过草稿回写已保存配置。
 */

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!isRecord(value)) return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child)
  return copy
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function equal(left, right) {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => equal(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => hasOwn(right, key) && equal(left[key], right[key]))
}

function revisionOf(value) {
  const revision = value === undefined ? 0 : value
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('revision must be a non-negative safe integer')
  }
  return revision
}

function optionsOf(value) {
  if (value === undefined) return {}
  if (Number.isSafeInteger(value)) return { revision: value }
  if (!isRecord(value)) throw new TypeError('draft options must be an object or revision')
  return value
}

function stateOf(value) {
  if (!isRecord(value) || !hasOwn(value, 'base') || !hasOwn(value, 'value')) {
    throw new TypeError('a draft created by createDraft is required')
  }
  return value
}

/**
 * 从已保存值建立草稿。options.value 可恢复未保存值，options.revision 记录基线版本。
 * value 与 base 深度相等时是 clean，否则恢复为 editing。
 */
export function createDraft(saved, options) {
  const source = optionsOf(options)
  const value = hasOwn(source, 'value') ? source.value : saved
  const dirty = !equal(value, saved)
  return deepFreeze({
    base: cloneValue(saved),
    value: cloneValue(value),
    revision: revisionOf(source.revision),
    phase: dirty ? 'editing' : 'clean',
    dirty,
  })
}

/**
 * 用完整新值编辑草稿；options.merge=true 时把 changes 作为浅补丁合并到当前对象值。
 * 编辑回 base 会自动回到 clean；重复编辑也不修改旧状态。
 */
export function editDraft(draft, changes, options) {
  const state = stateOf(draft)
  const source = optionsOf(options)
  let value = cloneValue(changes)
  if (source.merge === true) {
    if (!isRecord(state.value) || !isRecord(changes)) {
      throw new TypeError('merge editing requires object draft values and changes')
    }
    value = { ...cloneValue(state.value), ...cloneValue(changes) }
  }
  const base = hasOwn(source, 'base') ? source.base : state.base
  const revision = hasOwn(source, 'revision') ? source.revision : state.revision
  return createDraft(base, { value, revision })
}

/**
 * 放弃未保存内容并回到 clean。默认恢复 base；options.saved 可改用最新服务端值，
 * options.revision 可同时推进基线版本。
 */
export function clearDraft(draft, options) {
  const state = stateOf(draft)
  const source = optionsOf(options)
  const saved = hasOwn(source, 'saved') ? source.saved : state.base
  const revision = hasOwn(source, 'revision') ? source.revision : state.revision
  return createDraft(saved, { revision })
}
