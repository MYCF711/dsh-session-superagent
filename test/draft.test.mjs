import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraft, editDraft, clearDraft } from '../lib/rooms/draft.js'

function savedConfig() {
  return {
    repo: 'o/r',
    goal: '处理新条目',
    filters: { labels: ['bug'], skipDrafts: true },
  }
}

test('草稿：createDraft 建立 clean 基线，深复制并冻结所有嵌套值', () => {
  const saved = savedConfig()
  const before = structuredClone(saved)
  const draft = createDraft(saved, { revision: 3 })

  assert.deepEqual(draft, {
    base: saved,
    value: saved,
    revision: 3,
    phase: 'clean',
    dirty: false,
  })
  assert.notStrictEqual(draft.base, saved)
  assert.notStrictEqual(draft.value, saved)
  assert.notStrictEqual(draft.base, draft.value)
  assert.notStrictEqual(draft.value.filters, saved.filters)
  assert.equal(Object.isFrozen(draft), true)
  assert.equal(Object.isFrozen(draft.value.filters), true)
  assert.equal(Object.isFrozen(draft.value.filters.labels), true)
  assert.throws(() => { draft.value.goal = 'changed' }, TypeError)
  assert.deepEqual(saved, before, '创建草稿不得修改已保存配置')

  saved.filters.labels.push('later')
  assert.deepEqual(draft.value.filters.labels, ['bug'], '源对象后续变化不得穿透草稿')
})

test('草稿：完整值编辑进入 editing，重复转换幂等且不改旧状态', () => {
  const original = createDraft(savedConfig(), 2)
  const changed = { ...savedConfig(), goal: '只处理 PR' }
  const edited = editDraft(original, changed)

  assert.equal(edited.phase, 'editing')
  assert.equal(edited.dirty, true)
  assert.equal(edited.revision, 2)
  assert.equal(edited.base.goal, '处理新条目')
  assert.equal(edited.value.goal, '只处理 PR')
  assert.equal(original.phase, 'clean')
  assert.equal(original.value.goal, '处理新条目')

  const repeated = editDraft(original, changed)
  assert.notStrictEqual(repeated, edited, '状态转换始终返回新对象')
  assert.deepEqual(repeated, edited)

  const reverted = editDraft(edited, savedConfig())
  assert.equal(reverted.phase, 'clean')
  assert.equal(reverted.dirty, false)
  assert.deepEqual(reverted.value, reverted.base)
})

test('草稿：浅补丁编辑保留其他字段，嵌套补丁仍按值替换', () => {
  const draft = createDraft(savedConfig())
  const edited = editDraft(draft, {
    goal: '只处理 issue',
    filters: { labels: ['issue'] },
  }, { merge: true })

  assert.equal(edited.value.repo, 'o/r')
  assert.equal(edited.value.goal, '只处理 issue')
  assert.deepEqual(edited.value.filters, { labels: ['issue'] })
  assert.equal(edited.base.filters.skipDrafts, true)
  assert.throws(() => editDraft(createDraft([]), {}, { merge: true }), /merge editing/)
})

test('草稿：恢复未保存值后 clearDraft 放弃修改并保留基线 revision', () => {
  const saved = savedConfig()
  const restoredValue = { ...saved, goal: '恢复中的编辑' }
  const restored = createDraft(saved, { value: restoredValue, revision: 7 })
  assert.equal(restored.phase, 'editing')
  assert.equal(restored.dirty, true)
  assert.equal(restored.value.goal, '恢复中的编辑')

  const cleared = clearDraft(restored)
  assert.deepEqual(cleared, createDraft(saved, { revision: 7 }))
  assert.equal(cleared.phase, 'clean')
  assert.equal(cleared.dirty, false)
  assert.equal(cleared.revision, 7)
  assert.equal(restored.value.goal, '恢复中的编辑', '清空不得修改恢复草稿')
})

test('草稿：clearDraft 可重基到最新服务端值与 revision', () => {
  const edited = editDraft(createDraft(savedConfig(), { revision: 4 }), { ...savedConfig(), repo: 'old/repo' })
  const latest = { ...savedConfig(), repo: 'new/repo', goal: '服务端新目标' }
  const rebased = clearDraft(edited, { saved: latest, revision: 5 })

  assert.equal(rebased.phase, 'clean')
  assert.equal(rebased.dirty, false)
  assert.equal(rebased.revision, 5)
  assert.deepEqual(rebased.base, latest)
  assert.deepEqual(rebased.value, latest)
  assert.equal(edited.value.repo, 'old/repo')
})

test('草稿：编辑输入同样被复制，后续外部修改不影响草稿', () => {
  const changes = savedConfig()
  const edited = editDraft(createDraft(savedConfig()), changes)
  changes.filters.labels[0] = 'changed'
  changes.goal = 'changed'
  assert.equal(edited.value.filters.labels[0], 'bug')
  assert.equal(edited.value.goal, '处理新条目')
})

test('草稿：值比较不看对象键顺序，编辑回等价值即 clean', () => {
  const draft = createDraft({ a: 1, b: { c: 2 } }, {
    value: { b: { c: 2 }, a: 1 },
  })
  assert.equal(draft.phase, 'clean')
  assert.equal(draft.dirty, false)
})

test('草稿：非法 revision、状态与合并输入显式报错', () => {
  assert.throws(() => createDraft({}, { revision: -1 }), /revision/)
  assert.throws(() => createDraft({}, { revision: 1.5 }), /revision/)
  assert.throws(() => editDraft(null, {}), /createDraft/)
  assert.throws(() => clearDraft({}), /createDraft/)
})
