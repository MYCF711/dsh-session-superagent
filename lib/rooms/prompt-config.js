/**
 * 提示词配置房：只拥有单会话所需的少量模板。
 *
 * 配置形状与 i18n 房一致：{ zh: { key: template }, en: { key: template } }。
 * 所有创建与覆盖都返回深冻结的新对象；默认模板与调用方传入的对象绝不被改写。
 */

export const PROMPT_KEYS = Object.freeze(['wake', 'ack', 'outbox', 'resume'])
export const PROMPT_LANGUAGES = Object.freeze(['zh', 'en'])

const DEFAULTS = {
  zh: {
    wake: '【主理鱼】{repo} 有待处理更新：\n{items}\n本条目主理目标：{goal}',
    ack: '{repo} 已处理：{numbers}\n处理记录：{note}',
    outbox: '待回写 {ticketId}：\n{body}',
    resume: '人工恢复 {ticketId}。\n原因：{reason}\n请先读取当前状态，再继续未完成的工作。',
  },
  en: {
    wake: '[Superagent] Updates need attention in {repo}:\n{items}\nGoal: {goal}',
    ack: 'Handled in {repo}: {numbers}\nNote: {note}',
    outbox: 'Pending outbox delivery for {ticketId}:\n{body}',
    resume: 'Human resume requested for {ticketId}.\nReason: {reason}\nRead the current state before continuing unfinished work.',
  },
}

function freezeCatalog(catalogs) {
  for (const language of PROMPT_LANGUAGES) Object.freeze(catalogs[language])
  return Object.freeze(catalogs)
}

export const DEFAULT_PROMPTS = freezeCatalog({
  zh: { ...DEFAULTS.zh },
  en: { ...DEFAULTS.en },
})

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertLanguage(language) {
  if (!PROMPT_LANGUAGES.includes(language)) {
    throw new RangeError(`prompt language must be zh or en; received ${String(language)}`)
  }
  return language
}

function assertKey(key) {
  if (!PROMPT_KEYS.includes(key)) {
    throw new RangeError(`unknown prompt template: ${String(key)}`)
  }
  return key
}

function assertTemplate(template, key, language) {
  if (typeof template !== 'string' || !template.trim()) {
    throw new TypeError(`prompt template ${language}.${key} must be a non-empty string`)
  }
  return template
}

function copyOverrides(overrides) {
  if (!isRecord(overrides)) throw new TypeError('prompt overrides must be an object')
  for (const language of Object.keys(overrides)) assertLanguage(language)

  const copy = {}
  for (const language of PROMPT_LANGUAGES) {
    const localized = overrides[language] === undefined ? {} : overrides[language]
    if (!isRecord(localized)) throw new TypeError(`prompt overrides.${language} must be an object`)
    for (const key of Object.keys(localized)) assertKey(key)
    copy[language] = Object.fromEntries(PROMPT_KEYS
      .filter((key) => Object.hasOwn(localized, key))
      .map((key) => [key, assertTemplate(localized[key], key, language)]))
  }
  return copy
}

/** 部分覆盖会回退到内置默认；返回完整、独立且冻结的 zh/en 目录。 */
export function createPromptConfig(overrides = {}) {
  const custom = copyOverrides(overrides)
  return freezeCatalog({
    zh: { ...DEFAULT_PROMPTS.zh, ...custom.zh },
    en: { ...DEFAULT_PROMPTS.en, ...custom.en },
  })
}

/** 覆盖单一语言的一张模板，不改写原配置或默认对象。 */
export function setPromptOverride(config, key, language, template) {
  assertKey(key)
  assertLanguage(language)
  assertTemplate(template, key, language)
  const current = createPromptConfig(config)
  return createPromptConfig({
    ...current,
    [language]: { ...current[language], [key]: template },
  })
}

/** 清除单一语言的覆盖，让它重新跟随内置默认。 */
export function clearPromptOverride(config, key, language) {
  assertKey(key)
  assertLanguage(language)
  const current = createPromptConfig(config)
  return createPromptConfig({
    ...current,
    [language]: { ...current[language], [key]: DEFAULT_PROMPTS[language][key] },
  })
}
