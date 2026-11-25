/**
 * 极简 zh/en 文案房。
 *
 * - zh-CN / en-US 等标签归一到 zh / en，未知语言回退到 zh；
 * - 当前语言缺键时回退到另一种语言（也可显式关闭）；
 * - 所有 {variable} 必须显式提供，缺参抛错，不留下半渲染文本；
 * - 目录会被复制并冻结，withOverrides 返回新 translator。
 */

export const SUPPORTED_LANGUAGES = Object.freeze(['zh', 'en'])
export const DEFAULT_LANGUAGE = 'zh'

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g

export class MissingTemplateVariableError extends TypeError {
  constructor(missing, context = {}) {
    const where = context.key ? ` in ${context.key}` : ''
    super(`missing template variable${missing.length === 1 ? '' : 's'}${where}: ${missing.join(', ')}`)
    this.name = 'MissingTemplateVariableError'
    this.code = 'I18N_VARIABLES_MISSING'
    this.missing = Object.freeze([...missing])
    this.key = context.key || null
    this.language = context.language || null
  }
}

export class TemplateNotFoundError extends Error {
  constructor(key, languages) {
    super(`template not found: ${key} (tried ${languages.join(', ')})`)
    this.name = 'TemplateNotFoundError'
    this.code = 'I18N_TEMPLATE_MISSING'
    this.key = key
    this.languages = Object.freeze([...languages])
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertLanguage(language) {
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new RangeError(`catalog language must be zh or en; received ${String(language)}`)
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || !key.trim()) throw new TypeError('template key must be a non-empty string')
  return key
}

function assertTemplate(template, key, language) {
  if (typeof template !== 'string' || !template.trim()) {
    throw new TypeError(`template ${language}.${key} must be a non-empty string`)
  }
  return template
}

export function normalizeLanguage(language) {
  const tag = String(language || '').trim().toLowerCase().replaceAll('_', '-')
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  return DEFAULT_LANGUAGE
}

export function templateVariables(template) {
  if (typeof template !== 'string') throw new TypeError('template must be a string')
  return Object.freeze([...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]))])
}

export function interpolate(template, values = {}, context = {}) {
  if (typeof template !== 'string') throw new TypeError('template must be a string')
  if (!isRecord(values)) throw new TypeError('template values must be an object')
  const variables = templateVariables(template)
  const missing = variables.filter((key) => !Object.hasOwn(values, key) || values[key] === undefined || values[key] === null)
  if (missing.length > 0) throw new MissingTemplateVariableError(missing, context)
  return template.replace(PLACEHOLDER, (_, key) => String(values[key]))
}

function copyCatalogs(catalogs) {
  if (!isRecord(catalogs)) throw new TypeError('i18n catalogs must be an object')
  for (const language of Object.keys(catalogs)) assertLanguage(language)
  const copy = {}
  for (const language of SUPPORTED_LANGUAGES) {
    if (catalogs[language] === undefined) continue
    const localized = catalogs[language]
    if (!isRecord(localized)) throw new TypeError(`i18n catalogs.${language} must be an object`)
    copy[language] = Object.fromEntries(Object.entries(localized).map(([key, template]) => {
      assertKey(key)
      return [key, assertTemplate(template, key, language)]
    }))
  }
  return copy
}

function mergeCatalogs(catalogs, overrides) {
  const base = copyCatalogs(catalogs)
  const extra = copyCatalogs(overrides)
  const merged = {}
  for (const language of SUPPORTED_LANGUAGES) {
    if (base[language] || extra[language]) merged[language] = { ...base[language], ...extra[language] }
  }
  return merged
}

function freezeCatalogs(catalogs) {
  for (const localized of Object.values(catalogs)) Object.freeze(localized)
  return Object.freeze(catalogs)
}

function otherLanguage(language) {
  return language === 'zh' ? 'en' : 'zh'
}

function resolutionChain(language, fallbackLanguage) {
  const primary = normalizeLanguage(language)
  if (fallbackLanguage === false || fallbackLanguage === null) return [primary]
  const fallback = fallbackLanguage === undefined ? otherLanguage(primary) : normalizeLanguage(fallbackLanguage)
  return primary === fallback ? [primary] : [primary, fallback]
}

export function createI18n(catalogs = {}, options = {}) {
  if (!isRecord(options)) throw new TypeError('i18n options must be an object')
  const frozen = freezeCatalogs(copyCatalogs(catalogs))
  const language = normalizeLanguage(options.language)
  const fallbackOption = options.fallbackLanguage
  const fallbackLanguage = fallbackOption === false || fallbackOption === null
    ? null
    : normalizeLanguage(fallbackOption === undefined ? otherLanguage(language) : fallbackOption)

  const api = {
    language,
    fallbackLanguage,
    catalogs: frozen,

    resolve(key, requestedLanguage = language) {
      assertKey(key)
      const chain = resolutionChain(requestedLanguage, fallbackOption)
      for (const candidate of chain) {
        const localized = frozen[candidate]
        if (localized && Object.hasOwn(localized, key)) {
          return Object.freeze({
            key,
            language: candidate,
            fallback: candidate !== normalizeLanguage(requestedLanguage),
            text: localized[key],
          })
        }
      }
      throw new TemplateNotFoundError(key, chain)
    },

    t(key, values = {}, requestedLanguage = language) {
      const resolved = api.resolve(key, requestedLanguage)
      return interpolate(resolved.text, values, { key, language: resolved.language })
    },

    withOverrides(overrides) {
      return createI18n(mergeCatalogs(frozen, overrides), {
        language,
        fallbackLanguage: fallbackOption,
      })
    },
  }
  return Object.freeze(api)
}
