/**
 * 水位 v2 · 数据源房。
 *
 * 必需针脚：list / keyOf / cursorOf / compareCursor。
 * 可选针脚：listComments（comments）、acknowledge（ack）。
 * 网络实现可注入，状态与决策房不需要知道 GitHub/Gitee 的字段。
 */
import { createHash } from 'node:crypto'
import { parseGhInclude } from '../gh-format.js'
import { redact } from '../redact.js'
import {
  listGiteeItems,
  fetchGiteeLastComment,
  ensureGiteeLabel,
  addGiteeLabel,
  addGiteeComment,
} from '../gitee.js'

const CAPABILITY_METHOD = { comments: 'listComments', ack: 'acknowledge' }

export class CapabilityError extends Error {
  constructor(provider, capability) {
    super(`provider ${provider} does not support capability: ${capability}`)
    this.name = 'CapabilityError'
    this.code = 'CAPABILITY_MISSING'
    this.provider = provider
    this.capability = capability
  }
}

/** 定义并校验一个 provider；能力数组与函数实现必须一致。 */
export function defineProvider(spec = {}) {
  const name = String(spec.name || 'anonymous')
  for (const method of ['list', 'keyOf', 'cursorOf', 'compareCursor']) {
    if (typeof spec[method] !== 'function') throw new TypeError(`provider ${name} missing required pin: ${method}`)
  }
  const capabilities = new Set(['issues', ...(Array.isArray(spec.capabilities) ? spec.capabilities : [])])
  if (typeof spec.listComments === 'function') capabilities.add('comments')
  if (typeof spec.acknowledge === 'function') capabilities.add('ack')
  for (const [capability, method] of Object.entries(CAPABILITY_METHOD)) {
    if (capabilities.has(capability) && typeof spec[method] !== 'function') {
      throw new TypeError(`provider ${name} declares ${capability} but missing pin: ${method}`)
    }
  }
  const frozen = Object.freeze([...capabilities])
  return Object.freeze({
    name,
    capabilities: () => [...frozen],
    list: spec.list,
    keyOf: spec.keyOf,
    cursorOf: spec.cursorOf,
    compareCursor: spec.compareCursor,
    ...(typeof spec.listComments === 'function' ? { listComments: spec.listComments } : {}),
    ...(typeof spec.acknowledge === 'function' ? { acknowledge: spec.acknowledge } : {}),
  })
}

export function requireCapability(provider, capability) {
  if (!provider || !provider.capabilities().includes(capability)) {
    throw new CapabilityError(provider && provider.name || 'unknown', capability)
  }
  const method = CAPABILITY_METHOD[capability]
  return method ? provider[method] : true
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function labelNames(item, ackLabel) {
  const excluded = String(ackLabel || '').toLowerCase()
  return (Array.isArray(item.labels) ? item.labels : [])
    .map((label) => String(label && label.name || label || '').trim())
    .filter(Boolean)
    .filter((name) => name.toLowerCase() !== excluded)
    .sort((left, right) => left.localeCompare(right))
}

/** issue/PR 的语义指纹：不拿会被任意写操作推动的 updated_at 当内容本身。 */
export function issueCursor(item = {}, options = {}) {
  const semantic = {
    title: String(item.title || ''),
    body: String(item.body || ''),
    state: String(item.state || ''),
    state_reason: item.state_reason || null,
    author: String(item.user && item.user.login || ''),
    assignees: (Array.isArray(item.assignees) ? item.assignees : []).map((user) => String(user && user.login || '')).sort(),
    labels: labelNames(item, options.ackLabel),
    comments: item.comments === undefined ? null : Number(item.comments) || 0,
    draft: item.draft === true,
    pr: Boolean(item.pull_request),
  }
  return 'h:' + createHash('sha256').update(JSON.stringify(stable(semantic))).digest('hex')
}

export function issueKey(item) {
  return `issue:${String(item && item.number || '')}`
}

function compareCursor(left, right) {
  return left === right
}

function ghEnvValue(env) {
  return typeof env === 'function' ? env() : env
}

async function githubAcknowledge(context, run, env) {
  const { repo, number, label, note = '' } = context
  const call = async (args) => run('gh', args, { timeoutMs: 20000, env: ghEnvValue(env) })
  const ensured = await call(['api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${label}`, '-f', 'color=ededed'])
  if (ensured.code !== 0 && !/422|already exists/i.test(String(ensured.stderr || ''))) {
    return { ok: false, stage: 'ensure-label', error: redact(ensured.stderr).slice(0, 240) }
  }
  const labeled = await call(['api', '-X', 'POST', `repos/${repo}/issues/${number}/labels`, '-f', `labels[]=${label}`])
  if (labeled.code !== 0) return { ok: false, stage: 'label', error: redact(labeled.stderr).slice(0, 240) }
  if (note) {
    const commented = await call(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${note}`])
    if (commented.code !== 0) return { ok: false, stage: 'comment', error: redact(commented.stderr).slice(0, 240) }
  }
  return { ok: true }
}

export function createGithubProvider(options = {}) {
  const run = options.run
  if (typeof run !== 'function') throw new TypeError('createGithubProvider requires run')
  const env = options.env || {}
  return defineProvider({
    name: 'github',
    keyOf: issueKey,
    cursorOf: issueCursor,
    compareCursor,
    list: async ({ repo, etag = '', perPage = 20 } = {}) => {
      const size = Math.max(1, Math.min(100, Number(perPage) || 20))
      const args = ['api', '--include', `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=${size}`]
      if (etag) args.push('-H', 'If-None-Match: ' + etag)
      const res = await run('gh', args, { timeoutMs: 45000, env: ghEnvValue(env) })
      const parsed = parseGhInclude(res.stdout)
      if (res.code !== 0) {
        return { ok: false, status: parsed.status, code: res.code, error: redact(res.stderr || res.stdout).slice(0, 240) }
      }
      let items
      try {
        const body = String(parsed.body || '').trim()
        items = body ? JSON.parse(body) : []
      } catch {
        return { ok: false, status: parsed.status, error: 'non-json body', body: parsed.body }
      }
      if (!Array.isArray(items)) return { ok: false, status: parsed.status, error: 'body is not an array', body: parsed.body }
      return {
        ok: true, items, truncated: items.length >= size,
        status: parsed.status, etag: parsed.etag, body: parsed.body,
        remaining: parsed.remaining, resetAt: parsed.resetAt, retryAfter: parsed.retryAfter,
        pollInterval: parsed.pollInterval,
      }
    },
    acknowledge: (context) => githubAcknowledge(context, run, env),
    ...(typeof options.listComments === 'function' ? { listComments: options.listComments } : {}),
  })
}

export function createGiteeProvider(options = {}) {
  const token = String(options.token || '')
  const fetchImpl = options.fetchImpl || globalThis.fetch
  return defineProvider({
    name: 'gitee',
    keyOf: issueKey,
    cursorOf: issueCursor,
    compareCursor,
    list: ({ repo, perPage = 20, since = '' } = {}) => listGiteeItems({ repo, token, perPage, since, fetchImpl }),
    listComments: ({ repo, item, selfLogin = '' } = {}) => fetchGiteeLastComment({
      repo, token, item, selfLogin, fetchImpl, withStatus: true,
    }),
    acknowledge: async ({ repo, number, label, note = '', kind = 'issue' }) => {
      const ensured = await ensureGiteeLabel({ repo, token, label, fetchImpl })
      if (!ensured.ok) return { ok: false, stage: 'ensure-label', ...ensured }
      const labeled = await addGiteeLabel({ repo, token, number, label, fetchImpl })
      if (!labeled.ok) return { ok: false, stage: 'label', error: labeled.error }
      if (note) {
        const commented = await addGiteeComment({ repo, token, number, body: note, kind, fetchImpl })
        if (!commented.ok) return { ok: false, stage: 'comment', error: commented.error }
      }
      return { ok: true }
    },
  })
}

/** 所有 provider 共用的一致性套件；新增数据源不需要改状态/决策房。 */
export async function runProviderConformance(provider) {
  const checks = []
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) })
  check('name', typeof provider.name === 'string' && provider.name.length > 0)
  for (const method of ['list', 'keyOf', 'cursorOf', 'compareCursor']) check(`required:${method}`, typeof provider[method] === 'function')
  check('keyOf', typeof provider.keyOf(sampleConformanceItem()) === 'string')
  const cursor = provider.cursorOf(sampleConformanceItem())
  check('cursorOf', (typeof cursor === 'string' && cursor) || Number.isSafeInteger(cursor))
  check('compare:same', provider.compareCursor(cursor, cursor) === true)
  check('compare:different', provider.compareCursor(cursor, cursor === 'different' ? 'other' : 'different') === false)
  for (const capability of provider.capabilities()) {
    const method = CAPABILITY_METHOD[capability]
    if (method) check(`capability:${capability}`, typeof provider[method] === 'function')
  }
  const listed = await provider.list({ repo: 'o/r', perPage: 1 })
  check('list:structured', listed && listed.ok === true && Array.isArray(listed.items))
  return checks
}

function sampleConformanceItem() {
  return { number: 1, title: 'conformance', state: 'open', labels: [], assignees: [] }
}
