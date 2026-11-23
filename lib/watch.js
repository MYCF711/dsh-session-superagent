/**
 * Pure watcher logic — no I/O, no timers, no Cordis.
 *
 * Kept separate so the behaviour that matters (what counts as news, when a wake
 * is allowed, what the wake text says) is unit-testable without a DSH host.
 */
import { repoBadges, classifyGhError } from './gh-format.js'
import { DEFAULT_ACK_LABEL_GITEE } from './gitee.js'
import { mergeWatermarkStates, migrateV1Watermark } from './rooms/watermark-state.js'
import { projectWatcher } from './rooms/projection.js'

export const DEFAULT_BRAND_NAME = '主理鱼'

export function normalizeBrandName(value, fallback = DEFAULT_BRAND_NAME) {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  return text.replace(/[\r\n]+/g, ' ')
}

export function decideWake(status, subagents) {
  if (subagents && subagents.known !== false && Number(subagents.running) > 0) {
    return { ok: false, busy: true, reason: '还有 ' + Number(subagents.running) + ' 个子任务在跑 —— 等它们结束，这轮会自动顺延' }
  }
  if (!status) return { ok: true }
  if (status !== 'idle') return { ok: false, busy: true, reason: '会话正忙（agent busy: ' + status + '）—— 等它空闲，这轮会自动顺延' }
  return { ok: true }
}

export function wakeCriteria({ isolation } = {}) {
  const iso = isolation || {}
  const where = iso.dir
    ? '回写到哪：推分支并开 PR，然后在 issue 里留言 + watch_ack 打标签'
    : '回写到哪：在 issue 里留言 + watch_ack 打标签'
  return [
    '改了什么：文件清单 + 一句话为什么（别只写"已修复"）',
    '怎么验证的：跑过的测试/命令 + 结果；跑不了就写清为什么跑不了',
    where,
  ]
}

// KB: actionable-suggestion.md —— 每个提示都要能回答「我现在该做什么」
// KB: actionable-does-not-mean-repeated.md —— 可执行 ≠ 把同一份指令印 N 遍（见 mergeWakeTexts）
// KB: error-must-have-next-step.md —— 每个错误都要带下一步
export function buildWakeSections(repo, items, options = {}) {
  const list = items ?? []
  const brandName = normalizeBrandName(options.brandName)
  const more = Number(options.more) || 0
  const lines = list.map((item) => {
    const kind = item.pull_request ? 'PR' : 'issue'
    const draft = item.draft ? ' 草稿' : ''
    const who = (item.user && item.user.login) || '?'
    const labels = labelNames(item)
    const tail = [
      `(${kind}${draft})`,
      labels.length > 0 ? `标签: ${labels.join(', ')}` : null,
      (item.assignees ?? []).length > 0 ? `指派: ${item.assignees.map((a) => '@' + a.login).join(' ')}` : null,
      item.html_url,
      (stateReasonNote(item) && String(item.state_reason || '') === 'reopened') ? '⚠ ' + stateReasonNote(item) : null,
      assignmentNote(item) || null,
      (item.state === 'open' ? stalenessNote(item) : '') || null,
      linkedPrNote(item.linkedPr) || null,
      (options.seenBefore && options.seenBefore[String(item.number)])
        ? '⏰ 之前叫醒过（' + String(options.seenBefore[String(item.number)]).slice(0, 10) + '）'
        : null,
      (item.retryOf ? '↻ 上一轮提过，还没回执（第 ' + (Number(item.retryOf.tries) + 1) + ' 次）' : null),
      (options.acked && options.acked[String(item.number)])
        ? '↩ 上次处理（' + String(options.acked[String(item.number)].at).slice(0, 10) + '）：'
          + String(options.acked[String(item.number)].note)
        : null,
      item.lastComment
        ? '最后评论: ' + commentSummaryLine({
          login: item.lastComment.self ? '' : item.lastComment.login,
          at: item.lastComment.at,
        }, null) + (item.lastComment.self ? ' 我（上一轮留的）' : '')
        : null,
    ].filter(Boolean).join(' ')
    const safeTitle = String(item.title || '')
      .split(String.fromCharCode(13)).join(' ')
      .split(String.fromCharCode(10)).join(' ')
      .split('【').join('[')
      .split('】').join(']')
      .slice(0, 200)
    const MAX_LINE = 120
    const prefix = `#${item.number} [${item.state}] `
    const suffix = ` — @${who}`
    const room = Math.max(20, MAX_LINE - [...prefix].length - [...suffix].length)
    const chars = [...safeTitle]
    const shown = chars.length <= room ? safeTitle : chars.slice(0, room - 1).join('') + '…'
    const head = `${prefix}${shown}${suffix}`
    const oneLine = tail ? `${head} ${tail}` : head
    if ([...oneLine].length <= MAX_LINE) return oneLine
    const tailChars = [...tail]
    const tailFit = tailChars.length <= MAX_LINE ? tail : tailChars.slice(0, MAX_LINE - 1).join('') + '…'
    return `${head}\n  ${tailFit}`
  })
  const rest = (options.restNumbers ?? []).map((n) => '#' + n).join(' ')
  const iso = options.isolation
  const isoLine = iso && iso.dir
    ? `【隔离工作区】${iso.dir}（分支 ${iso.branch}）—— 只在这里改，推这个分支开 PR，别碰主工作区；用完 git worktree remove 掉。`
    : iso && iso.error
      ? `【隔离失败】${iso.error}；这次请谨慎，改完别留下未提交内容。`
      : ''
  const goalLine = options.goal
    ? `本条目主理目标：${String(options.goal).split(String.fromCharCode(13)).join(' ').split(String.fromCharCode(10)).join(' ').slice(0, 200)}`
    : ''
  const identityLine = options.identityBound
    ? '【提交身份】本插件的 gh 已绑定单独的智能体账号。你在会话里执行 git / git push 时如需一致身份，'
      + '请向用户索取该账号的 gh 配置目录并设 GH_CONFIG_DIR；否则提交会落到操作者账号上。'
    : ''
  const moreLine = more > 0
    ? `（另有 ${more} 条：${rest}，处理完这批再看）`
    : ''
  const whyLine = (() => {
    const parts = []
    const changed = Number(options.changedTotal)
    const count = list.length
    const onlyOne = count <= 1 && (!Number.isFinite(changed) || changed <= 1)
    if (!onlyOne) {
      if (Number.isFinite(changed) && changed > 0) parts.push('本轮共 ' + changed + ' 条变化')
      if (options.batchLimit) {
        const priorityOn = Boolean(options.priority && (options.priority.reopened !== false || options.priority.comments !== false || options.priority.labels !== false))
        parts.push(priorityOn
          ? '按优先级取前 ' + options.batchLimit + ' 条（重开的排最前）'
          : '按优先级取前 ' + options.batchLimit + ' 条')
      }
    }
    const skipped = options.skippedReasons && typeof options.skippedReasons === 'object'
      ? Object.entries(options.skippedReasons).filter(([, n]) => Number(n) > 0).slice(0, 3)
      : []
    if (skipped.length > 0) {
      const total = Object.values(options.skippedReasons).reduce((sum, n) => sum + (Number(n) || 0), 0)
      const more = Object.keys(options.skippedReasons).length > skipped.length ? ' 等' : ''
      parts.push('本轮跳过 ' + total + ' 条（' + skipped.map(([reason, n]) => reason + ' × ' + n).join('、') + more + '）')
    }
    return parts.length > 0 ? '【为什么是这几条】' + parts.join('；') : ''
  })()
  const accessLine = options.access ? '【权限提示】' + options.access : ''
  const criteria = Array.isArray(options.criteria) ? options.criteria.filter(Boolean).slice(0, 4) : []
  const criteriaLines = criteria.length > 0
    ? ['【完成标准】', ...criteria.map((line, i) => (i + 1) + '. ' + line)]
    : []
  const headerLine = options.firstSync
    ? `【${brandName}】${repo} 首次同步：仓库里现有 ${lines.length} 条待处理（接上之前就在的，不是刚刚发生）：`
    : `【${brandName}】${repo} 有 ${lines.length} 条新动态：`
  const nextLine = '接下来：先读仓库 AGENTS.md 定「修 / 回 / 待定」；没有测试结果不算完成；'
    + (options.provider === 'gitee'
      ? '做完一条就写回 Gitee（网页或 API 都行）+ watch_ack 打标签，不要扩大范围。'
      : '做完一条就写回 GitHub + watch_ack 打标签，不要扩大范围。')

  const sections = [
    { id: 'header', lines: [headerLine] },
    { id: 'facts', lines },
  ]
  if (whyLine) sections.push({ id: 'selection', lines: [whyLine] })
  if (moreLine) sections.push({ id: 'overflow', lines: [moreLine] })
  if (isoLine) sections.push({ id: 'isolation', lines: [isoLine] })
  if (goalLine) sections.push({ id: 'goal', lines: [goalLine] })
  if (identityLine) sections.push({ id: 'identity', lines: [identityLine] })
  if (accessLine) sections.push({ id: 'access', lines: [accessLine] })
  if (criteriaLines.length > 0) sections.push({ id: 'criteria', lines: criteriaLines })
  sections.push({ id: 'next', lines: ['', nextLine] })
  return sections
}

export function formatWatchText(repo, fresh, options = {}) {
  return buildWakeSections(repo, fresh, options)
    .map((section) => section.lines.join('\n'))
    .join('\n')
}

export const DEFAULT_FILTERS = {
  labels: [],
  ignoreLabels: [],
  skipBots: true,
  skipDrafts: true,
  skipClosed: true,
  onlyAssigned: false,
  assignee: null,
  allowAuthors: [],
}

export function normalizeFilters(raw) {
  const f = raw && typeof raw === 'object' ? raw : {}
  const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [])
  return {
    labels: list(f.labels),
    ignoreLabels: list(f.ignoreLabels),
    skipBots: f.skipBots !== false,
    skipDrafts: f.skipDrafts !== false,
    skipClosed: f.skipClosed !== false,
    onlyAssigned: f.onlyAssigned === true,
    onlyNewComments: f.onlyNewComments === true,
    assignee: typeof f.assignee === 'string' && f.assignee.trim() ? f.assignee.trim() : null,
    allowAuthors: list(f.allowAuthors).map((n) => n.replace(/^@/, '')),
  }
}

const labelNames = (item) => (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
const isBot = (item) => {
  const user = item.user || {}
  return user.type === 'Bot' || /\[bot\]$/i.test(String(user.login || ''))
}

// KB: filter-explainability.md —— 让「为什么没叫醒」有答案（每条被过滤的都要留原因）
export function filterReason(item, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) }
  if (f.skipClosed && item.state && item.state !== 'open') return '已关闭'
  if (f.skipDrafts && item.draft) return '草稿 PR'
  if (f.skipBots && isBot(item)) return '机器人'

  const names = labelNames(item).map((n) => String(n).toLowerCase())
  const lower = (arr) => (arr || []).map((n) => String(n).toLowerCase())
  const ignored = lower(f.ignoreLabels).find((n) => names.includes(n))
  if (ignored) return '排除标签: ' + ignored
  if (f.labels.length > 0 && !lower(f.labels).some((n) => names.includes(n))) {
    return '不在标签白名单: ' + f.labels.join(',')
  }

  if (Array.isArray(f.allowAuthors) && f.allowAuthors.length > 0) {
    const login = String((item.user && item.user.login) || '').toLowerCase()
    const allowed = f.allowAuthors.map((n) => String(n).replace(/^@/, '').toLowerCase())
    if (!allowed.includes(login)) return '作者不在名单: @' + (login || '?')
  }

  if (f.onlyAssigned) {
    const assignees = (item.assignees ?? []).map((a) => String((a && a.login) || a).toLowerCase())
    if (f.assignee) return assignees.includes(f.assignee.toLowerCase()) ? null : '未指派给 @' + f.assignee
    return assignees.length > 0 ? null : '没有指派给人'
  }
  return null
}

export function passesFilters(item, filters = DEFAULT_FILTERS) {
  return filterReason(item, filters) === null
}

export function pushFiltered(log, record, max = 5) {
  const list = Array.isArray(log) ? log.slice() : []
  list.push(record)
  return list.slice(-Math.max(1, max))
}

export const DEFAULT_PRIORITY = { reopened: true, comments: true, labels: true, unassigned: false }

// KB: priority-configurable.md —— 优先级权重是产品配置，不写死在排序器里。
export function priorityScore(item, options) {
  if (!item || typeof item !== 'object') return 0
  const on = { ...DEFAULT_PRIORITY, ...(options || {}) }
  let score = 0
  if (on.reopened !== false && String(item.state_reason || '') === 'reopened') score += 100
  if (on.comments !== false && Number(item.comments) > 0) score += 10
  if (on.labels !== false && Array.isArray(item.labels) && item.labels.length > 0) score += 5
  if (on.unassigned === true && assignmentNote(item) !== '') score += 3
  if (on.stale === true && stalenessNote(item) !== '') score += 2
  return score
}

export function batchFresh(fresh, limit = 3, priority) {
  const list = Array.isArray(fresh) ? fresh.slice() : []
  const n = Math.max(1, Number(limit) || 3)
  const ranked = list
    .map((item, index) => ({ item, index, score: priorityScore(item, priority) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.item)
  return ranked.slice(0, n)
}

export function recordOtherError(entry, detail) {
  const text = String(detail || '').trim().slice(0, 120)
  if (!text) return entry
  entry.events = pushEvent(entry.events, { kind: 'other', text })
  return entry
}
export function clearBackoff(entry) {
  if (!entry || typeof entry !== 'object') return entry
  entry.nextAt = null
  entry.deferReason = null
  entry.consecutiveFailures = 0
  return entry
}

export function enterActiveHoursDefer(entry, waitMs, hours, at = new Date()) {
  entry.nextAt = new Date(at.getTime() + Number(waitMs || 0)).toISOString()
  entry.lastDeferred = `不在活跃时段（${hours}），${Math.round(Number(waitMs || 0) / 60000)} 分钟后开始`
  entry.deferReason = 'active-hours'
  entry.lastError = null
  entry.lastErrorAt = null
  entry.consecutiveFailures = 0
  return entry
}
export function permanentBackoffMs(kind, baseMs = 60000) {
  const PERMANENT = new Set(['notfound', 'moved', 'auth'])
  if (!PERMANENT.has(kind)) return 0
  return Math.max(30 * 60 * 1000, Number(baseMs) || 0)
}
export const RETRY_BUDGET_ATTEMPTS = 6
export const RETRY_SLOW_CAP_MINUTES = 120
export function nextDelayMs(entry, baseMs) {
  const failures = Number((entry && entry.consecutiveFailures) || 0)
  if (failures <= 0) return baseMs
  const overBudget = failures >= RETRY_BUDGET_ATTEMPTS
  const factor = Math.min(2 ** failures, overBudget ? 120 : 60)
  const cap = overBudget ? RETRY_SLOW_CAP_MINUTES * 60 * 1000 : 30 * 60 * 1000
  return Math.min(Math.max(baseMs * factor, baseMs), cap)
}

export function pruneWakeTimes(times, now = Date.now()) {
  const floor = now - 60 * 60 * 1000
  const list = Array.isArray(times) ? times : []
  return list.map(Number).filter((t) => Number.isFinite(t) && t >= floor)
}

export function applyWatcherAction(state, { action, id } = {}) {
  const watchers = (state && state.watchers) || {}
  if (typeof id !== 'string' || !id || !Object.prototype.hasOwnProperty.call(watchers, id)) {
    return { ok: false, error: `unknown watcher: ${id || '(missing id)'}` }
  }
  const entry = watchers[id]
  if (action === 'delete') {
    delete watchers[id]
    return { ok: true, action, id, deleted: true }
  }
  if (action === 'pause') {
    entry.enabled = false
    return { ok: true, action, id, enabled: false }
  }
  if (action === 'resume') {
    entry.enabled = true
    entry.lastError = null
    clearBackoff(entry)
    return { ok: true, action, id, enabled: true }
  }
  return { ok: false, error: 'action must be pause | resume | delete' }
}

export const DEFAULT_ACK_LABEL = '主理鱼:已处理'

export function hasAckLabel(item, label = DEFAULT_ACK_LABEL) {
  const want = String(label).toLowerCase()
  return labelNames(item).some((n) => String(n).toLowerCase() === want)
}

export function worktreePlan({ workdir, repo, sessionTag, stamp = Date.now() } = {}) {
  const safeRepo = String(repo || 'repo').replace(/[^A-Za-z0-9._-]+/g, '-')
  const safeTag = String(sessionTag || 'session').replace(/^session-/, '').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 8) || 'session'
  const id = `${safeRepo}-${safeTag}-${Number(stamp).toString(36)}`
  const root = String(workdir || '.').replace(/[\\/]+$/, '')
  return {
    id,
    dir: `${root}/.dsh-zhuli/${id}`,
    branch: `zhuli/${id}`,
  }
}

export function staleWorktrees(entries, options = {}) {
  const { now = Date.now(), keepMs = 3 * 24 * 3600 * 1000, keepCount = 5 } = options
  const list = (entries ?? []).filter((entry) => entry && entry.name && Number.isFinite(Number(entry.mtimeMs)))
  const byAge = list.filter((entry) => now - Number(entry.mtimeMs) > keepMs)
  const cap = Math.max(0, Number(keepCount) || 0)
  const newest = list.slice().sort((a, b) => Number(b.mtimeMs) - Number(a.mtimeMs)).slice(0, cap)
  const keep = new Set(newest.map((entry) => entry.name))
  const byCount = list.filter((entry) => !keep.has(entry.name))
  const out = []
  const seen = new Set()
  for (const entry of [...byAge, ...byCount]) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    out.push(entry)
  }
  return out
}

const ACTIVE_HOURS_SEGMENT_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/

function parseActiveHours(spec) {
  if (!spec || typeof spec !== 'string') return []
  const segments = spec.split(/[,;]/).map((segment) => segment.trim())
  if (segments.some((segment) => !segment)) return null
  const parsed = []
  for (const segment of segments) {
    const match = segment.match(ACTIVE_HOURS_SEGMENT_RE)
    if (!match) return null
    const toMin = (h, mi) => (Number(h) * 60 + Number(mi)) % (24 * 60)
    parsed.push({ start: toMin(match[1], match[2]), end: toMin(match[3], match[4]) })
  }
  return parsed
}

function insideActiveSegment(segment, current) {
  if (segment.start === segment.end) return true
  return segment.start < segment.end
    ? current >= segment.start && current < segment.end
    : current >= segment.start || current < segment.end
}

export function inActiveHours(spec, now = new Date()) {
  const segments = parseActiveHours(spec)
  if (!segments || segments.length === 0) return true
  const current = now.getHours() * 60 + now.getMinutes()
  return segments.some((segment) => insideActiveSegment(segment, current))
}

export function pushHistory(history, record, max = 20) {
  const list = Array.isArray(history) ? history.slice() : []
  list.push(record)
  return list.slice(-Math.max(1, max))
}

export const POLL_RESULT_FIELDS = [
  'lastPoll', 'lastError', 'nextAt', 'consecutiveFailures', 'seen', 'cursor', 'lastReported',
  'lastWake', 'lastWakeCount', 'lastBatch', 'lastWakeItem', 'lastAbsorbed', 'wakeTimes', 'lastDeferred',
  'history', 'lastWorktree', 'lastAcked', 'lastTrigger',
  'filteredLog',
  'lastReopened', 'lastStates',
  'etag', 'lastFreshAt', 'needsReauth', 'lastErrorAt', 'deferReason', 'silentWakes', 'prevWakeAt',
  'dailyWakes', 'absorbedLog', 'filterCounts', 'repoAccess', 'sessionMissingSince',
  'minIntervalSec', 'lastCleanupAt',
  'acked', 'pending',
  'seenComments',
  'watermarkVersion', 'round', 'obs', 'v1Migrated',
]

export function mergePollResult(stored, polled) {
  const merged = { ...(stored || {}) }
  for (const key of POLL_RESULT_FIELDS) {
    if (polled && polled[key] !== undefined) merged[key] = polled[key]
  }
  if (stored && polled) {
    const storedAcked = stored.acked && typeof stored.acked === 'object' ? stored.acked : null
    if (storedAcked) {
      const acked = { ...(polled.acked && typeof polled.acked === 'object' ? polled.acked : {}) }
      for (const [key, record] of Object.entries(storedAcked)) {
        const prev = acked[key]
        const at = Date.parse(String(record && record.at))
        const prevAt = Date.parse(String(prev && prev.at))
        if (!prev || (Number.isFinite(at) && (!Number.isFinite(prevAt) || at > prevAt))) {
          acked[key] = record
        }
      }
      merged.acked = acked
    }

    const storedLastAcked = stored.lastAcked && typeof stored.lastAcked === 'object' ? stored.lastAcked : null
    const mergedLastAcked = merged.lastAcked && typeof merged.lastAcked === 'object' ? merged.lastAcked : null
    if (storedLastAcked && (!mergedLastAcked
      || Date.parse(String(storedLastAcked.at)) > Date.parse(String(mergedLastAcked.at)))) {
      merged.lastAcked = storedLastAcked
    }

  }
  if (stored || polled) {
    const v2 = mergeWatermarkStates(migrateV1Watermark(stored || {}), migrateV1Watermark(polled || {}))
    merged.watermarkVersion = v2.watermarkVersion
    merged.round = v2.round
    merged.obs = v2.obs
  }
  return merged
}

export function mergeFilters(base, patch) {
  const current = normalizeFilters(base)
  if (!patch || typeof patch !== 'object') return current
  const next = { ...current }
  if ('labels' in patch) next.labels = normalizeFilters({ labels: patch.labels }).labels
  if ('ignoreLabels' in patch) next.ignoreLabels = normalizeFilters({ ignoreLabels: patch.ignoreLabels }).ignoreLabels
  if ('skipBots' in patch) next.skipBots = patch.skipBots !== false
  if ('skipDrafts' in patch) next.skipDrafts = patch.skipDrafts !== false
  if ('skipClosed' in patch) next.skipClosed = patch.skipClosed !== false
  if ('onlyAssigned' in patch) next.onlyAssigned = patch.onlyAssigned === true
  if ('onlyNewComments' in patch) next.onlyNewComments = patch.onlyNewComments === true
  if ('assignee' in patch) next.assignee = normalizeFilters({ assignee: patch.assignee }).assignee
  if ('allowAuthors' in patch) next.allowAuthors = normalizeFilters({ allowAuthors: patch.allowAuthors }).allowAuthors
  return next
}

import {
  assignmentNote, commentSummaryLine, linkedPrNote, stalenessNote, stateReasonNote,
} from './gh-format.js'
export {
  TRIAGE_SIGNALS,
  accessNote,
  assignmentNote,
  buildCommentBatchQuery,
  classifyGhError,
  commentSummaryLine,
  countReasons,
  isAuthBroken,
  diagnoseEmptyBody,
  diagnoseBadBody,
  formatGhCall,
  jitterMs,
  linkedPrNote,
  parseCommentBatch,
  parseGhInclude,
  pickLinkedPullRequests,
  pickSuggestion,
  repoBadges,
  repoStructureNote,
  retryAfterMs,
  stalenessNote,
  stateReasonNote,
  throttleDelayMs,
} from './gh-format.js'

export function msUntilActiveWindow(spec, now = new Date()) {
  const segments = parseActiveHours(spec)
  if (!segments || segments.length === 0) return 0
  const curMin = now.getHours() * 60 + now.getMinutes()
  if (segments.some((segment) => insideActiveSegment(segment, curMin))) return 0
  const curSec = now.getSeconds()
  const waits = segments.map((segment) => {
    let diffMin = segment.start - curMin
    if (diffMin <= 0) diffMin += 24 * 60
    return Math.max(1000, diffMin * 60 * 1000 - curSec * 1000)
  })
  return Math.min(...waits)
}

export function nextWaketimeAt(wakeTimes, cap, now = Date.now()) {
  const times = pruneWakeTimes(wakeTimes, now).sort((a, b) => a - b)
  const n = Math.max(1, Number(cap) || 6)
  if (times.length < n) return now
  const freeing = times[times.length - n]
  return freeing + 60 * 60 * 1000
}

export function sessionWakesLastHour(entries, sessionId, now = Date.now()) {
  if (!sessionId) return 0
  const list = Array.isArray(entries) ? entries : Object.values(entries || {})
  let total = 0
  for (const entry of list) {
    if (!entry || entry.sessionId !== sessionId) continue
    total += pruneWakeTimes(entry.wakeTimes, now).length
  }
  return total
}

export function mergeWakeTexts(parts, options = {}) {
  const list = (Array.isArray(parts) ? parts : []).filter((t) => typeof t === 'string' && t.trim())
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  const seenCriteria = new Set()
  const seenGoal = new Set()
  const trimmed = list.map((text) => {
    let out = text
    const criteriaAt = out.indexOf('【完成标准】')
    if (criteriaAt >= 0) {
      const block = out.slice(criteriaAt)
      if (seenCriteria.has(block)) out = out.slice(0, criteriaAt).replace(/[\s]+$/, '')
      else seenCriteria.add(block)
    }
    out = out
      .split(String.fromCharCode(10))
      .filter((line) => {
        if (!line.startsWith('本条目主理目标：')) return true
        if (seenGoal.has(line)) return false
        seenGoal.add(line)
        return true
      })
      .join(String.fromCharCode(10))
    return out
  })
  const TAIL = '接下来：'
  const tailBlock = (() => {
    for (const text of trimmed) {
      const at = text.indexOf(TAIL)
      if (at >= 0) return text.slice(at).replace(/[\s]+$/, '')
    }
    return ''
  })()
  const stripped = trimmed.map((text) => {
    const at = text.indexOf(TAIL)
    return at < 0 ? text : text.slice(0, at).replace(/[\s]+$/, '')
  })

  const brandName = normalizeBrandName(options && options.brandName)
  const head = '【' + brandName + '】这一小段时间内有 ' + list.length + ' 处变化，合并成一条：'
  const body = stripped.map((text, i) => String.fromCharCode(10, 10) + '—— 第 ' + (i + 1) + ' 处 ——' + String.fromCharCode(10) + text).join('')
  return head + body + (tailBlock ? String.fromCharCode(10, 10) + tailBlock : '')
}

export function shouldRunCleanup({ count = 0, keepCount = 5, lastRunAt = 0, now = Date.now(), intervalMs = 10 * 60 * 1000 } = {}) {
  const total = Number(count) || 0
  const cap = Math.max(1, Number(keepCount) || 5)
  if (total > cap) return { run: true, reason: 'over-cap' }
  const last = Number(lastRunAt) || 0
  if (last > 0 && now - last < Number(intervalMs)) return { run: false, reason: 'throttled' }
  return { run: true, reason: 'interval' }
}

export function pushEvent(events, event, max = 20) {
  const list = Array.isArray(events) ? events.slice() : []
  const limit = Math.max(1, Number(max) || 20)
  if (!event || typeof event !== 'object' || !event.kind) return list.slice(-limit)
  const at = event.at || new Date().toISOString()
  const next = {
    at,
    since: at,
    kind: String(event.kind).slice(0, 24),
    text: String(event.text || '').slice(0, 160),
  }
  const last = list[list.length - 1]
  if (last && last.kind === next.kind && last.text === next.text) {
    last.at = next.at
    last.count = (Number(last.count) || 1) + 1
    if (!last.since) last.since = last.at // 老数据补一个，免得显示成"持续 0 分钟"
    return list.slice(-limit)
  }
  list.push(next)
  return list.slice(-limit)
}

export function durationText(sinceIso, untilIso) {
  const from = Date.parse(String(sinceIso || ''))
  const to = Date.parse(String(untilIso || ''))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return ''
  const minutes = Math.floor((to - from) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? hours + ' 小时 ' + rest + ' 分' : hours + ' 小时'
}

export function silentStreak({ previousWakeAt, lastAckedAt, previousStreak = 0 } = {}) {
  const streak = Math.max(0, Number(previousStreak) || 0)
  const wakeAt = Date.parse(String(previousWakeAt || ''))
  if (!Number.isFinite(wakeAt)) return streak // 还没唤醒过：保持原状
  const ackAt = Date.parse(String(lastAckedAt || ''))
  if (Number.isFinite(ackAt) && ackAt >= wakeAt) return 0
  return streak + 1
}

export function summarizeByRepo(watchers) {
  const list = Array.isArray(watchers) ? watchers.filter((w) => w && w.repo) : []
  const groups = new Map()
  for (const watcher of list) {
    const repo = String(watcher.repo)
    const group = groups.get(repo) || { repo, count: 0, lastWake: null, lastPoll: null, silentWakes: 0, errors: 0, enabled: 0, badges: [] }
    group.count += 1
    if (watcher.enabled !== false) group.enabled += 1
    if (watcher.lastWake && (!group.lastWake || String(watcher.lastWake) > String(group.lastWake))) group.lastWake = watcher.lastWake
    if (watcher.lastPoll && (!group.lastPoll || String(watcher.lastPoll) > String(group.lastPoll))) group.lastPoll = watcher.lastPoll
    group.silentWakes = Math.max(group.silentWakes, Number(watcher.silentWakes) || 0)
    if (watcher.lastError || watcher.poll === 'boot-miss' || watcher.poll === 'stalled') group.errors += 1
    for (const badge of repoBadges(watcher.repoAccess) || []) {
      if (!group.badges.some((b) => b.text === badge.text)) group.badges.push(badge)
    }
    groups.set(repo, group)
  }
  const weight = (g) => (g.errors > 0 ? 0 : g.silentWakes >= 2 ? 1 : 2)
  return [...groups.values()].sort((a, b) => (weight(a) - weight(b)) || a.repo.localeCompare(b.repo))
}

export const CAP_REASONS = ['cap-session', 'cap-watcher']

export function countCapped(watchers) {
  const list = Array.isArray(watchers) ? watchers : Object.values(watchers || {})
  return list.filter((w) => w && CAP_REASONS.includes(w.deferReason)).length
}

export function splitBatch(fresh, limit = 3, priority) {
  const listed = batchFresh(fresh, limit, priority)
  const picked = new Set(listed.map((item) => item.number))
  const rest = (Array.isArray(fresh) ? fresh : []).filter((item) => !picked.has(item.number))
  return { listed, rest }
}

export function itemTrace(watcher, number) {
  if (!watcher || number === null || number === undefined || number === '') return null
  const target = String(number).trim()
  if (!target) return null
  const row = watcher.obs && (watcher.obs[`issue:${target}`] || watcher.obs[`pr:${target}/comment`])
  const rawSeen = (row && (row.handled && row.handled.cursor || row.delivered && row.delivered.cursor || row.cursor))
    || (watcher.seen && watcher.seen[target]) || null
  const seen = typeof rawSeen === 'string' && rawSeen.startsWith('v1:') ? rawSeen.slice(3) : rawSeen
  const reported = (row && row.delivered && row.delivered.at) || (watcher.lastReported && watcher.lastReported[target]) || null
  const filtered = (Array.isArray(watcher.filteredLog) ? watcher.filteredLog : [])
    .filter((entry) => String(entry.number) === target)
    .map((entry) => ({ at: entry.at, reason: entry.reason, title: entry.title }))
  const absorbed = (Array.isArray(watcher.absorbedLog) ? watcher.absorbedLog : [])
    .filter((entry) => String(entry.number) === target)
    .map((entry) => ({ at: entry.at, title: entry.title }))
  const wakes = (Array.isArray(watcher.history) ? watcher.history : [])
    .filter((entry) => Array.isArray(entry.numbers) && entry.numbers.map(String).includes(target))
    .map((entry) => ({ at: entry.at, ok: Boolean(entry.ok), reason: entry.reason || null }))

  let verdict
  if (filtered.length > 0 && !seen && !reported) verdict = '被过滤掉了：' + (filtered[filtered.length - 1].reason || '未知原因')
  else if (wakes.some((w) => w.ok)) verdict = '已经唤醒过 ' + wakes.filter((w) => w.ok).length + ' 次'
  else if (absorbed.length > 0) verdict = '被冷却期吸收了（' + (absorbed[absorbed.length - 1].at || '未知时间') + '）—— 那一批刚唤醒过，等下一轮'
  else if (seen) verdict = '已记入水位但没唤醒（仅观察，或上报前就已存在）'
  else if (wakes.length > 0) verdict = '尝试唤醒过 ' + wakes.length + ' 次但都没成功'
  else verdict = '还没轮到它（可能还没被轮询到，或在批外）'

  return { number: target, repo: watcher.repo || null, seen, reported, filtered, absorbed, wakes, verdict }
}

export function suggestSessionCap({ used = 0, cap = 12, capped = 0, max = 60 } = {}) {
  const u = Math.max(0, Number(used) || 0)
  const c = Math.max(1, Number(cap) || 12)
  const blocked = Math.max(0, Number(capped) || 0)
  if (u < c) return null // 还没用满，不需要建议
  const doubled = c * 2
  const wanted = blocked > 0 ? doubled : c + Math.ceil(c / 2)
  return Math.min(Math.max(1, Number(max) || 60), wanted)
}

export function bumpDailyWakes(daily, atIso = new Date().toISOString(), keepDays = 7) {
  const day = String(atIso).slice(0, 10)
  const map = (daily && typeof daily === 'object' && !Array.isArray(daily)) ? { ...daily } : {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return map
  map[day] = (Number(map[day]) || 0) + 1
  const days = Object.keys(map).sort().slice(-Math.max(1, Number(keepDays) || 7))
  const out = {}
  for (const key of days) out[key] = map[key]
  return out
}

export function dailySummary(daily, todayIso = new Date().toISOString()) {
  const map = (daily && typeof daily === 'object' && !Array.isArray(daily)) ? daily : {}
  const values = Object.values(map).map(Number).filter((n) => Number.isFinite(n) && n >= 0)
  if (values.length === 0) return null
  const total = values.reduce((a, b) => a + b, 0)
  const day = String(todayIso).slice(0, 10)
  return {
    days: values.length,
    total,
    avg: Math.round((total / values.length) * 10) / 10,
    today: Number(map[day]) || 0,
  }
}

export function busierThanUsual(summary, { factor = 2, minDays = 3 } = {}) {
  if (!summary || !Number.isFinite(Number(summary.days)) || summary.days < minDays) return false
  const avg = Number(summary.avg) || 0
  const today = Number(summary.today) || 0
  if (avg <= 0) return false // 历史为 0 时没有可比基线
  return today >= avg * Math.max(1.5, Number(factor) || 2)
}

export function defaultAckLabelFor(provider, labels) {
  const map = labels && typeof labels === 'object' ? labels : null
  if (provider === 'gitee') return (map && map.gitee) || DEFAULT_ACK_LABEL_GITEE
  return (map && map.github) || DEFAULT_ACK_LABEL
}

// KB: tool-panel-parity.md —— 工具与面板共享同一投影，不各自解释水位。
export function statusView(entries, options = {}) {
  const list = (Array.isArray(entries) ? entries : Object.values(entries || {}))
    .filter((w) => w && w.kind !== 'pr' && !String(w.id || '').startsWith('pr:'))
  const sessionId = options.sessionId || (list[0] && list[0].sessionId) || null
  const capped = countCapped(list)
  const used = sessionId ? sessionWakesLastHour(list, sessionId) : 0
  const cap = Number((list[0] && list[0].sessionMaxWakes)) || 12
  return {
    schemaVersion: 1,
    session: {
      id: sessionId,
      used,
      cap,
      capped,
      suggest: list.length === 0 ? null : suggestSessionCap({ used, cap, capped }),
    },
    watchers: list.map((w) => {
      const projected = projectWatcher(w)
      const healthNow = pollHealth(w, { now: options.now, bootAt: options.bootAt })
      const stopped = STOPPED_STATES.has(healthNow.state) ? healthNow.state : null
      return {
      repo: w.repo || null,
      provider: w.provider === 'gitee' ? 'gitee' : 'github',
      executionMode: w.executionMode === 'worker' ? 'worker' : 'inline',
      sessionId: w.sessionId || null,
      enabled: projected.enabled,
      intervalSec: Number(w.intervalSec) || 60,
      observe: w.observe === true,
      isolated: w.isolated === true,
      activeHours: w.activeHours || null,
      labels: (w.filters && Array.isArray(w.filters.labels)) ? w.filters.labels.slice() : [],
      onlyAssigned: Boolean(w.filters && w.filters.onlyAssigned),
      onlyNewComments: Boolean(w.filters && w.filters.onlyNewComments),
      batchLimit: w.batchLimit ?? 5,
      maxWakesPerHour: w.maxWakesPerHour ?? 6,
      sessionMaxWakes: w.sessionMaxWakes ?? 12,
      isolateKeepDays: w.isolateKeepDays ?? 3,
      maxIsolated: w.maxIsolated ?? 5,
      ackLabel: w.ackLabel ?? defaultAckLabelFor(w.provider, options.defaultAckLabels),
      workdir: w.workdir ?? null,
      priority: { ...DEFAULT_PRIORITY, ...((w.priority && typeof w.priority === 'object' && !Array.isArray(w.priority)) ? w.priority : {}) },
      ignoreLabels: (w.filters && Array.isArray(w.filters.ignoreLabels)) ? w.filters.ignoreLabels.slice() : [],
      assignee: (w.filters && w.filters.assignee) || null,
      allowAuthors: (w.filters && Array.isArray(w.filters.allowAuthors)) ? w.filters.allowAuthors.slice() : [],
      deferReason: projected.deferReason,
      lastDeferred: w.lastDeferred || null,
      silentWakes: Number(w.silentWakes) || 0,
      cursor: projected.lastDeliveryAt || w.cursor || null,
      lastPoll: w.lastPoll || null,
      // 只在停摆时输出；缺省即健康，避免 20 条守的 /state 超出 50KB 预算。
      ...(stopped ? { poll: stopped } : {}),
      lastWake: w.lastWake || null,
      lastError: projected.lastError,
      lastErrorKind: w.lastError ? classifyGhError(String(w.lastError)).kind : null,
      }
    }),
  }
}

/** 需要人处理的轮询停摆状态。 */
export const STOPPED_STATES = new Set(['boot-miss', 'stalled'])

export const SESSION_MISSING_GRACE_MS = 10 * 60 * 1000

/** 调度器与健康判据共用启用语义，兼容手工写入的 false/0/no/off。 */
export function isWatcherEnabled(entry) {
  if (!entry) return false
  const value = entry.enabled
  if (value === undefined || value === null) return true
  if (value === false || value === 0) return false
  const text = String(value).trim().toLowerCase()
  return !(text === 'false' || text === '0' || text === 'no' || text === 'off')
}

/**
 * 面板、/state 与 doctor 共用的轮询健康判据。
 * paused/never/deferred/grace/ok 都不是故障；boot-miss 与 stalled 才需要处理。
 */
export function pollHealth(entry, options = {}) {
  const src = entry && typeof entry === 'object' ? entry : {}
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const intervalSec = Math.max(30, Number(src.intervalSec) || 60)
  const staleMs = Math.max(intervalSec * 3000, 5 * 60 * 1000)
  const bootAtRaw = Number(options.bootAt)
  const bootAt = Number.isFinite(bootAtRaw) && bootAtRaw > 0 ? bootAtRaw : null
  const uptimeMs = bootAt === null ? Infinity : now - bootAt
  if (!isWatcherEnabled(src)) return { state: 'paused' }
  const nextAt = typeof src.nextAt === 'string' ? Date.parse(src.nextAt) : NaN
  if ((Number.isFinite(nextAt) && nextAt > now) || src.deferReason) return { state: 'deferred' }
  if (src.activeHours && !inActiveHours(src.activeHours, new Date(now))) return { state: 'deferred' }
  const lastPollAt = typeof src.lastPoll === 'string' ? Date.parse(src.lastPoll) : NaN
  if (!Number.isFinite(lastPollAt)) {
    const createdAt = typeof src.createdAt === 'string' ? Date.parse(src.createdAt) : NaN
    // 新守的首轮有豁免；创建已久且进程也跑过停滞周期仍无首轮，不能永远显示健康。
    if (Number.isFinite(createdAt) && now - createdAt > staleMs && uptimeMs > staleMs) return { state: 'boot-miss' }
    return { state: 'never' }
  }
  const ageMs = Math.max(0, now - lastPollAt)
  const beforeBoot = bootAt !== null && lastPollAt < bootAt
  if (beforeBoot && uptimeMs > staleMs) return { state: 'boot-miss' }
  if (ageMs > staleMs && uptimeMs > staleMs) return { state: 'stalled' }
  if (ageMs > staleMs) return { state: 'grace' }
  return { state: 'ok' }
}

export function sessionMissingVerdict({ missingSince, now = Date.now(), graceMs = SESSION_MISSING_GRACE_MS } = {}) {
  const since = Date.parse(String(missingSince || ''))
  if (!Number.isFinite(since)) {
    return { grace: true, startedAt: new Date(now).toISOString(), waitMin: Math.ceil(graceMs / 60000), justNow: true }
  }
  const left = graceMs - (now - since)
  if (left > 0) return { grace: true, startedAt: new Date(since).toISOString(), waitMin: Math.max(1, Math.ceil(left / 60000)) }
  return { grace: false, waitedMin: Math.max(1, Math.round((now - since) / 60000)) }
}

export function parseRepoSpec(input) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: false, error: 'repo 不能为空' }
  let provider = 'github'
  let rest = raw

  const url = raw.match(/^https?:\/\/([^/]+)\/(.+)$/i)
  if (url) {
    const host = url[1].toLowerCase()
    rest = url[2]
    if (host === 'gitee.com' || host.endsWith('.gitee.com')) provider = 'gitee'
    else if (host === 'github.com' || host.endsWith('.github.com')) provider = 'github'
    else return { ok: false, error: '只支持 github.com 与 gitee.com 的地址' }
  } else {
    const prefixed = raw.match(/^(github|gitee)\s*[:：]\s*(.+)$/i)
    if (prefixed) {
      provider = prefixed[1].toLowerCase()
      rest = prefixed[2]
    }
  }

  rest = rest.replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) return { ok: false, error: '要写成 owner/name' }
  const [owner, name] = parts
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { ok: false, error: 'owner/name 只能包含字母、数字、下划线、点、短横线' }
  }
  if (owner === '.' || owner === '..' || name === '.' || name === '..') {
    return { ok: false, error: 'owner/name 不能是 . 或 ..' }
  }
  return { ok: true, provider, repo: owner + '/' + name, spec: provider === 'github' ? owner + '/' + name : 'gitee:' + owner + '/' + name }
}

export function markGiteeReopened(items, lastStates = {}) {
  const list = items || []
  for (const item of list) {
    const prev = lastStates[String(item.number)]
    if (!item.state_reason && prev === 'closed' && item.state === 'open') item.state_reason = 'reopened'
  }
  const next = { ...lastStates }
  for (const item of list) next[String(item.number)] = item.state
  const alive = new Set(list.map((item) => String(item.number)))
  for (const key of Object.keys(next)) if (!alive.has(key)) delete next[key]
  return next
}

export function planWakeSettlement(entry, { ok, reason, busy: busyFlag = false, fresh = [], listed = fresh, firstSync = false, baseMs = 60000, now = Date.now() } = {}) {
  const at = new Date(now).toISOString()
  const numbers = (fresh || []).map((item) => item && item.number).filter(Boolean)
  const oldest = (fresh || [])
    .map((item) => Date.parse(String((item && (item.updated_at || item.updatedAt)) || '')))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0]
  const history = pushHistory(entry.history, {
    at,
    numbers,
    ok: Boolean(ok),
    reason: ok ? null : String(reason || '').slice(0, 120),
    oldest: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
  })
  const lastWake = ok ? at : 'failed: ' + String(reason || '')

  if (!ok) {
    const busy = busyFlag === true || /busy|running|idle/i.test(String(reason || ''))
    return {
      lastWake,
      history,
      lastBatch: numbers,
      lastWakeCount: Number(entry.lastWakeCount) || 0,
      commitEtag: false,
      advanceWatermark: false,
      deferReason: 'busy',
      lastDeferred: busy ? '会话正忙，下一轮重试' : (entry.lastDeferred || null),
      bumpBackoff: !busy,
      baseMs,
      error: busy ? null : 'wake: ' + String(reason || ''),
    }
  }

  return {
    lastWake,
    history,
    lastBatch: numbers,
    lastWakeCount: (fresh || []).length,
    commitEtag: (fresh || []).length > 0,
    advanceWatermark: (fresh || []).length > 0,
    silentWakes: silentStreak({
      previousWakeAt: entry.prevWakeAt,
      lastAckedAt: entry.lastAcked && entry.lastAcked.at,
      previousStreak: entry.silentWakes,
    }),
    prevWakeAt: at,
    wakeTimes: [...(entry.wakeTimes || []), now],
    dailyWakes: bumpDailyWakes(entry.dailyWakes, at),
    lastDeferred: null,
    deferReason: null,
    ackedRecovered: Boolean(entry.prevWakeAt && silentStreak({
      previousWakeAt: entry.prevWakeAt,
      lastAckedAt: entry.lastAcked && entry.lastAcked.at,
      previousStreak: entry.silentWakes,
    }) === 0),
    eventKind: firstSync ? 'baseline' : 'wake',
    eventText: (firstSync ? '首次同步（存量 ' : '唤醒了 ') + numbers.length + ' 条' + (firstSync ? '）' : '') + '：' + numbers.map((n) => '#' + n).join(' '),
    error: null,
  }
}

export function effectiveIntervalMs(entry, baseMs) {
  const floor = (Number(entry && entry.minIntervalSec) || 0) * 1000
  return Math.max(Number(baseMs) || 0, floor)
}

export function validateActiveHours(spec) {
  if (spec === null || spec === undefined || spec === '') return { ok: true, empty: true }
  const text = String(spec).trim()
  const segments = text.split(/[,;]/).map((segment) => segment.trim())
  const formatReason = '格式要写成 HH:MM-HH:MM，多段用逗号或分号分隔（例如 09:00-12:00,14:00-23:00），收到的是「' + text + '」'
  if (segments.some((segment) => !segment)) return { ok: false, reason: formatReason + '（不能有空白段）' }
  for (const segment of segments) {
    const match = segment.match(ACTIVE_HOURS_SEGMENT_RE)
    if (!match) return { ok: false, reason: formatReason }
    const parts = [match[1], match[2], match[3], match[4]].map(Number)
    if (parts[0] > 23 || parts[2] > 23 || parts[1] > 59 || parts[3] > 59) {
      return { ok: false, reason: '时要在 00-23、分要在 00-59（每段格式 HH:MM-HH:MM，多段用逗号或分号分隔），收到的是「' + text + '」' }
    }
  }
  return { ok: true, normalized: segments.join(',') }
}

export function wakeQuality(entry, options = {}) {
  const { now = Date.now() } = options
  const history = Array.isArray(entry && entry.history) ? entry.history : []
  const acked = (entry && entry.acked && typeof entry.acked === 'object') ? entry.acked : {}
  const lastAcked = (entry && entry.lastAcked && Array.isArray(entry.lastAcked.numbers)) ? entry.lastAcked.numbers : []

  const wokenNumbers = new Set()
  const ackedNumbers = new Set()
  const latencies = []

  for (const key of Object.keys(acked)) ackedNumbers.add(String(key))
  for (const n of lastAcked) ackedNumbers.add(String(n))

  let wakeCount = 0
  for (const event of history) {
    if (!event || event.ok !== true) continue
    wakeCount += 1
    for (const n of event.numbers || []) wokenNumbers.add(String(n))
    const at = Date.parse(String(event.at || ''))
    const oldest = Date.parse(String(event.oldest || ''))
    if (Number.isFinite(at) && Number.isFinite(oldest) && at >= oldest) latencies.push(at - oldest)
  }

  let hit = 0
  for (const n of wokenNumbers) if (ackedNumbers.has(n)) hit += 1

  latencies.sort((a, b) => a - b)
  const medianLatencyMs = latencies.length === 0
    ? null
    : latencies[Math.floor(latencies.length / 2)]

  return {
    wakeCount,
    itemsWoken: wokenNumbers.size,
    itemsAcked: hit,
    actionRate: wokenNumbers.size === 0 ? null : Math.round((hit / wokenNumbers.size) * 100) / 100,
    medianLatencyMs,
    silentWakes: Number((entry && entry.silentWakes) || 0),
    verdict: wokenNumbers.size === 0
      ? '还没有叫醒过'
      : (hit / wokenNumbers.size < 0.7
        ? '叫醒后有动作的比例偏低（' + hit + '/' + wokenNumbers.size + '）—— 可能叫醒的是噪音'
        : '正常（' + hit + '/' + wokenNumbers.size + ' 有动作）'),
  }
}
