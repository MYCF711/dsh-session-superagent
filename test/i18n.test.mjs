import assert from 'node:assert/strict'
import test from 'node:test'

import { createPromptConfig, DEFAULT_PROMPTS, PROMPT_KEYS } from '../lib/rooms/prompt-config.js'
import {
  DEFAULT_LANGUAGE,
  MissingTemplateVariableError,
  TemplateNotFoundError,
  normalizeLanguage,
  templateVariables,
  interpolate,
  createI18n,
} from '../lib/rooms/i18n.js'

const VALUES = Object.freeze({
  repo: 'acme/widget',
  items: '#7 修复登录',
  goal: '完成修复并回写',
  numbers: '#7',
  note: '已修复',
  ticketId: 'ticket:github:acme/widget#7',
  body: '评论正文',
  reason: '人工确认继续',
})

test('i18n：严格插值支持重复变量与 0/false/空串，且不改写参数', () => {
  const values = { name: 'Ada', zero: 0, disabled: false, empty: '' }
  const snapshot = { ...values }
  assert.equal(
    interpolate('{name}/{name}/{zero}/{disabled}/{empty}', values),
    'Ada/Ada/0/false/',
  )
  assert.deepEqual(values, snapshot)
  assert.deepEqual(templateVariables('{name}/{name}/{zero}'), ['name', 'zero'])
})

test('i18n：缺参、null/undefined 与继承属性都抛出结构化错误', () => {
  const inherited = Object.create({ repo: 'not-own' })
  inherited.items = 'item'
  inherited.goal = undefined
  assert.throws(() => interpolate('{repo}:{items}:{goal}:{extra}', inherited, {
    key: 'wake', language: 'zh',
  }), (error) => {
    assert.ok(error instanceof MissingTemplateVariableError)
    assert.equal(error.code, 'I18N_VARIABLES_MISSING')
    assert.deepEqual(error.missing, ['repo', 'goal', 'extra'])
    assert.equal(error.key, 'wake')
    assert.equal(error.language, 'zh')
    assert.match(error.message, /repo, goal, extra/)
    return true
  })
  assert.throws(() => interpolate('{value}', { value: null }), MissingTemplateVariableError)
  assert.throws(() => interpolate('{value}', []), /object/)
})

test('i18n：真实四张默认模板都能以 zh/en 完整渲染', () => {
  const translator = createI18n(createPromptConfig())
  for (const language of ['zh', 'en']) {
    for (const key of PROMPT_KEYS) {
      const rendered = translator.t(key, VALUES, language)
      assert.ok(rendered.length > 0)
      assert.doesNotMatch(rendered, /\{[A-Za-z][A-Za-z0-9_]*\}/, `${language}.${key}`)
      assert.ok(rendered.includes(VALUES.repo) || key === 'outbox' || key === 'resume')
    }
  }
  assert.match(translator.t('wake', VALUES, 'zh'), /主理鱼/)
  assert.match(translator.t('wake', VALUES, 'en'), /Superagent/)
})

test('i18n：zh 缺键回退 en，en 缺键也回退 zh，并标记实际语言', () => {
  const translator = createI18n({
    zh: { onlyZh: '中文 {value}', shared: '中文' },
    en: { onlyEn: 'English {value}', shared: 'English' },
  })
  assert.equal(translator.t('onlyEn', { value: 7 }, 'zh'), 'English 7')
  assert.equal(translator.t('onlyZh', { value: 8 }, 'en'), '中文 8')
  assert.deepEqual(translator.resolve('onlyEn', 'zh'), {
    key: 'onlyEn', language: 'en', fallback: true, text: 'English {value}',
  })
  assert.equal(translator.resolve('shared', 'en').fallback, false)
  assert.equal(translator.t('onlyZh', { value: 0 }, 'zh-CN'), '中文 0')
})

test('i18n：语言标签归一，未知请求回退 zh，缺失键与关闭回退都显式失败', () => {
  assert.equal(DEFAULT_LANGUAGE, 'zh')
  assert.equal(normalizeLanguage('zh-Hans-CN'), 'zh')
  assert.equal(normalizeLanguage('EN_us'), 'en')
  assert.equal(normalizeLanguage('fr-FR'), 'zh')

  const translator = createI18n({ zh: { hello: '你好' }, en: { hello: 'Hello' } })
  assert.equal(translator.t('hello', {}, 'fr-FR'), '你好')
  assert.throws(() => translator.t('absent'), TemplateNotFoundError)
  const strict = createI18n({ zh: { hello: '你好' }, en: {} }, { fallbackLanguage: false })
  assert.throws(() => strict.t('hello', {}, 'en'), (error) => {
    assert.ok(error instanceof TemplateNotFoundError)
    assert.deepEqual(error.languages, ['en'])
    return true
  })
})

test('i18n：withOverrides 不可变，外部事后改目录不会污染 translator', () => {
  const catalogs = { zh: { wake: '原 {value}' }, en: { wake: 'Original {value}' } }
  const base = createI18n(catalogs)
  const changed = base.withOverrides({ zh: { wake: '新 {value}', ack: '回执 {value}' } })
  catalogs.zh.wake = '外部篡改 {value}'

  assert.equal(base.t('wake', { value: 1 }), '原 1')
  assert.equal(changed.t('wake', { value: 1 }), '新 1')
  assert.equal(changed.t('wake', { value: 1 }, 'en'), 'Original 1')
  assert.equal(changed.t('ack', { value: 2 }, 'en'), '回执 2')
  assert.notStrictEqual(changed, base)
  assert.ok(Object.isFrozen(base) && Object.isFrozen(base.catalogs) && Object.isFrozen(base.catalogs.zh))
  assert.equal(DEFAULT_PROMPTS.zh.ack.includes('{numbers}'), true)
})

test('i18n：覆盖模板同样执行严格缺参检查，不把占位符留给模型', () => {
  const translator = createI18n(createPromptConfig({ zh: { wake: '{repo}：{items}：{goal}' } }))
  assert.throws(() => translator.t('wake', { repo: 'o/r', items: '#1' }), (error) => {
    assert.ok(error instanceof MissingTemplateVariableError)
    assert.deepEqual(error.missing, ['goal'])
    assert.equal(error.key, 'wake')
    assert.equal(error.language, 'zh')
    return true
  })
})

test('i18n：非法目录、空文案与未知目录语言都拒绝', () => {
  assert.throws(() => createI18n([]), /object/)
  assert.throws(() => createI18n({ fr: { hello: 'bonjour' } }), /language/)
  assert.throws(() => createI18n({ zh: [] }), /object/)
  assert.throws(() => createI18n({ zh: { hello: '' } }), /non-empty/)
  assert.throws(() => createI18n({ zh: { '': 'bad' } }), /key/)
  assert.throws(() => createI18n({ zh: { hello: '你好' } }).t('hello', null), /object/)
})
