import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROMPT_KEYS,
  PROMPT_LANGUAGES,
  DEFAULT_PROMPTS,
  createPromptConfig,
  setPromptOverride,
  clearPromptOverride,
} from '../lib/rooms/prompt-config.js'

function variables(template) {
  return [...new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))].sort()
}

test('提示词房：只有 wake/ack/outbox/resume 四张单会话模板，zh/en 变量一致', () => {
  assert.deepEqual(PROMPT_KEYS, ['wake', 'ack', 'outbox', 'resume'])
  assert.deepEqual(PROMPT_LANGUAGES, ['zh', 'en'])
  for (const language of PROMPT_LANGUAGES) {
    assert.deepEqual(Object.keys(DEFAULT_PROMPTS[language]).sort(), [...PROMPT_KEYS].sort())
    assert.ok(Object.isFrozen(DEFAULT_PROMPTS[language]))
  }
  assert.ok(Object.isFrozen(DEFAULT_PROMPTS))
  for (const key of PROMPT_KEYS) {
    assert.deepEqual(variables(DEFAULT_PROMPTS.zh[key]), variables(DEFAULT_PROMPTS.en[key]), key)
  }
  const all = PROMPT_LANGUAGES.flatMap((language) => PROMPT_KEYS.map((key) => DEFAULT_PROMPTS[language][key])).join('\n')
  assert.doesNotMatch(all, /orchestrator|worker pool|团队多角色|多智能体角色/i)
})

test('提示词房：部分覆盖回退默认，调用方事后改 overrides 不影响配置', () => {
  const overrides = { zh: { wake: '自定义 {repo}：{items}；{goal}' } }
  const config = createPromptConfig(overrides)
  overrides.zh.wake = '事后篡改 {repo}'
  overrides.en = { ack: '事后新增 {numbers}' }

  assert.equal(config.zh.wake, '自定义 {repo}：{items}；{goal}')
  assert.equal(config.zh.ack, DEFAULT_PROMPTS.zh.ack)
  assert.equal(config.en.wake, DEFAULT_PROMPTS.en.wake)
  assert.equal(config.en.ack, DEFAULT_PROMPTS.en.ack)
  assert.notStrictEqual(config, DEFAULT_PROMPTS)
  assert.notStrictEqual(config.zh, DEFAULT_PROMPTS.zh)
  assert.ok(Object.isFrozen(config.zh))
})

test('提示词房：setPromptOverride 不可变且只改指定语言与键', () => {
  const original = createPromptConfig()
  const next = setPromptOverride(original, 'resume', 'en', 'Resume {ticketId}: {reason}')

  assert.equal(next.en.resume, 'Resume {ticketId}: {reason}')
  assert.equal(next.zh.resume, DEFAULT_PROMPTS.zh.resume)
  assert.equal(next.en.wake, DEFAULT_PROMPTS.en.wake)
  assert.equal(original.en.resume, DEFAULT_PROMPTS.en.resume)
  assert.equal(DEFAULT_PROMPTS.en.resume.includes('Human resume requested'), true)
  assert.notStrictEqual(next, original)
  assert.notStrictEqual(next.en, original.en)
  assert.ok(Object.isFrozen(next) && Object.isFrozen(next.en))
})

test('提示词房：连续覆盖不清掉其他键，清除后精确回到默认', () => {
  const first = setPromptOverride(createPromptConfig(), 'ack', 'zh', '完成 {repo} {numbers}：{note}')
  const second = setPromptOverride(first, 'outbox', 'zh', '发送 {ticketId}：{body}')
  const cleared = clearPromptOverride(second, 'ack', 'zh')

  assert.equal(second.zh.ack, '完成 {repo} {numbers}：{note}')
  assert.equal(second.zh.outbox, '发送 {ticketId}：{body}')
  assert.equal(cleared.zh.ack, DEFAULT_PROMPTS.zh.ack)
  assert.equal(cleared.zh.outbox, '发送 {ticketId}：{body}')
  assert.equal(first.zh.outbox, DEFAULT_PROMPTS.zh.outbox)
  assert.deepEqual(clearPromptOverride(second, 'ack', 'zh'), cleared, '重复清除结果一致')
})

test('提示词房：默认对象被冻结，覆盖动作不能反向污染默认', () => {
  assert.throws(() => { DEFAULT_PROMPTS.zh.wake = '污染' }, TypeError)
  assert.throws(() => { DEFAULT_PROMPTS.en.extra = '污染' }, TypeError)
  const custom = createPromptConfig({ en: { wake: 'Custom {repo} {items} {goal}' } })
  assert.throws(() => { custom.en.wake = '污染' }, TypeError)
  assert.equal(DEFAULT_PROMPTS.en.wake.includes('[Superagent]'), true)
})

test('提示词房：未知键、未知语言、空模板和非对象输入都显式拒绝', () => {
  assert.throws(() => createPromptConfig({ fr: { wake: 'bonjour' } }), /language/)
  assert.throws(() => createPromptConfig({ zh: { orchestrator: 'bad' } }), /unknown prompt/)
  assert.throws(() => createPromptConfig({ zh: { wake: '  ' } }), /non-empty/)
  assert.throws(() => createPromptConfig([]), /object/)
  assert.throws(() => createPromptConfig({ zh: [] }), /object/)
  assert.throws(() => setPromptOverride(createPromptConfig(), 'worker', 'zh', 'bad'), /unknown prompt/)
  assert.throws(() => setPromptOverride(createPromptConfig(), 'wake', 'fr', 'bad'), /language/)
  assert.throws(() => clearPromptOverride(createPromptConfig(), 'wake', 'fr'), /language/)
})
