/**
 * 随包 skill 的严格解析与模型可见工具契约校验。
 *
 * 文件读取由调用方注入；本模块不直接访问磁盘、环境或宿主服务。
 */
export const GITHUB_SKILL_NAME = 'dsh-session-superagent-github'
export const GITHUB_SKILL_PATH = 'skills/dsh-session-superagent-github/SKILL.md'

export class SkillPackError extends Error {
  constructor(code, message, { path = 'SKILL.md', cause, missingTools = [], requiredTools = [] } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SkillPackError'
    this.code = code
    this.path = path
    this.missingTools = Object.freeze([...missingTools])
    this.requiredTools = Object.freeze([...requiredTools])
  }
}

function sourcePath(options) {
  if (typeof options === 'string') return options
  return options && typeof options.path === 'string' ? options.path : 'SKILL.md'
}

export function parseSkillPack(source, options = {}) {
  const path = sourcePath(options)
  if (typeof source !== 'string' || !source.trim()) {
    throw new SkillPackError('SKILL_EMPTY', `Empty skill pack: ${path}`, { path })
  }
  const text = source.replaceAll('\r\n', '\n')
  // 与随包格式约定一致：只允许 name 与 description 两个字段，且正文前留一空行。
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new SkillPackError('SKILL_FRONTMATTER_INVALID', `Invalid skill pack: ${path}`, { path })
  const [, name, rawDescription, content] = match
  const description = rawDescription.trim()
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new SkillPackError('SKILL_NAME_INVALID', `Invalid skill name in ${path}: ${name}`, { path })
  }
  if (!description) throw new SkillPackError('SKILL_DESCRIPTION_EMPTY', `Empty skill description: ${path}`, { path })
  if (!content.trim()) throw new SkillPackError('SKILL_CONTENT_EMPTY', `Empty skill content: ${path}`, { path })
  return Object.freeze({ name, description, content, path })
}

export function loadSkillPack(path, readFile) {
  if (typeof readFile !== 'function') throw new TypeError('loadSkillPack requires readFile')
  let source
  try {
    source = readFile(path, 'utf8')
  } catch (error) {
    throw new SkillPackError('SKILL_READ_FAILED', `Cannot read skill pack: ${path}`, { path, cause: error })
  }
  return parseSkillPack(source, { path })
}

/** Return every referenced plugin tool once, in first-appearance order. */
export function skillToolReferences(packOrContent) {
  const content = packOrContent && typeof packOrContent === 'object'
    ? String(packOrContent.content || '')
    : String(packOrContent || '')
  const names = new Set()
  for (const match of content.matchAll(/\b(?:github|repo_here|watch_[a-z][a-z0-9_]*)\b/g)) names.add(match[0])
  return Object.freeze([...names])
}

function availableToolNames(tools) {
  if (tools == null) return new Set()
  if (tools instanceof Map) return new Set([...tools.keys()].map(String))
  if (typeof tools !== 'string' && typeof tools[Symbol.iterator] === 'function') {
    const names = new Set()
    for (const tool of tools) {
      if (typeof tool === 'string') names.add(tool)
      else if (tool && typeof tool.name === 'string') names.add(tool.name)
    }
    return names
  }
  if (typeof tools === 'object') return new Set(Object.keys(tools))
  throw new TypeError('available tools must be an iterable, Map, or object')
}

export function validateSkillPack(packOrSource, availableTools, options = {}) {
  const pack = typeof packOrSource === 'string' ? parseSkillPack(packOrSource, options) : packOrSource
  const path = pack && typeof pack.path === 'string' ? pack.path : sourcePath(options)
  if (!pack || typeof pack.name !== 'string' || typeof pack.content !== 'string' || !pack.content.trim()) {
    throw new SkillPackError('SKILL_INVALID', `Invalid parsed skill pack: ${path}`, { path })
  }
  if (options.expectedName && pack.name !== options.expectedName) {
    throw new SkillPackError('SKILL_NAME_MISMATCH', `Skill ${pack.name} must be named ${options.expectedName}`, { path })
  }

  const tools = skillToolReferences(pack)
  const available = availableToolNames(availableTools)
  const missingTools = tools.filter((name) => !available.has(name))
  if (missingTools.length) {
    throw new SkillPackError(
      'SKILL_TOOL_UNKNOWN',
      `Skill ${pack.name} references unregistered tools: ${missingTools.join(', ')}`,
      { path, missingTools },
    )
  }

  const requiredTools = Array.isArray(options.requiredTools) ? options.requiredTools.map(String) : []
  const unreferenced = requiredTools.filter((name) => !tools.includes(name))
  if (unreferenced.length) {
    throw new SkillPackError(
      'SKILL_TOOL_UNREFERENCED',
      `Skill ${pack.name} does not reference required tools: ${unreferenced.join(', ')}`,
      { path, requiredTools: unreferenced },
    )
  }
  return Object.freeze({ ok: true, name: pack.name, tools })
}

export function validateGithubSkillPack(packOrSource, availableTools, options = {}) {
  const requiredTools = [...new Set(['github', ...(options.requiredTools || [])])]
  return validateSkillPack(packOrSource, availableTools, {
    ...options,
    expectedName: GITHUB_SKILL_NAME,
    requiredTools,
  })
}
