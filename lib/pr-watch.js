
export function normalizeSelf(login) {
  return String(login ?? '').trim().replace(/^@+/, '').toLowerCase()
}

function normalizeRepo(name) {
  return String(name ?? '').trim().toLowerCase()
}

export function isForkPr(pr) {
  if (!pr || typeof pr !== 'object') return false
  const head = normalizeRepo(pr.headRepo)
  const base = normalizeRepo(pr.baseRepo)
  return Boolean(head && base && head !== base)
}

export function pickNewComments(comments, seenId) {
  const list = Array.isArray(comments) ? comments : []
  const threshold = Number(seenId) || 0
  return list.filter((comment) => {
    const id = Number(comment && comment.id)
    return Number.isFinite(id) && id > threshold
  })
}

export function shouldWake(comments, self) {
  const list = Array.isArray(comments) ? comments : []
  const me = normalizeSelf(self)
  return list.some((comment) => normalizeSelf(comment && comment.author) !== me)
}

export function buildPrWakeText(opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const comments = Array.isArray(options.comments) ? options.comments : []
  const base = String(options.base ?? '')
  const number = String(options.number ?? '')
  const lines = [
    '【PR 响应】' + base + '#' + number + ' 有 ' + comments.length + ' 条新评论',
    '',
    'PR: ' + String(options.title ?? ''),
    '分支: ' + String(options.branch ?? ''),
  ]
  for (const comment of comments) {
    const item = comment && typeof comment === 'object' ? comment : {}
    const body = String(item.body ?? '').trim()
    lines.push('评论者: ' + String(item.author ?? '') + '（非本人）')
    lines.push('时间: ' + String(item.createdAt ?? ''))
    lines.push('')
    const bodyLines = body.length > 0 ? body.split(/\r\n|\n|\r/) : ['']
    for (const line of bodyLines) lines.push('> ' + line)
    lines.push('')
  }
  const auditMode = String(options.auditMode === 'inline' ? 'inline' : 'subagent')
  const audits = []
  if (options.audit === true) audits.push('审计')
  if (options.adversarialAudit === true) audits.push('对抗性审计')
  const review = audits.length > 0
    ? '自审（' + auditMode + ' 驱动的' + audits.join('和') + '）'
    : '自审'
  lines.push('处理建议: 阅读评论 → 从 remote 同步代码 → 修改代码 → ' + review + ' → 提交 → 回评')
  if (options.goal) lines.push('目标: ' + String(options.goal))
  return lines.join('\n')
}
