/**
 * Ticket 生命周期房。
 *
 * 只管理 open → assigned / waiting → ended，以及显式人类重开；不订阅评论、
 * 不启动执行器。状态与历史均为可持久化 JSON，所有输出深冻结，eventId 用于
 * 跨重启识别重复事件；持久化冲突仍由宿主的 commit(next, expected) 裁决。
 */

const STATUSES = new Set(['open', 'assigned', 'waiting', 'ended'])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]))
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function isDeepFrozen(value) {
  if (!value || typeof value !== 'object') return true
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen)
}

function unchanged(ticket) {
  return isDeepFrozen(ticket) ? ticket : deepFreeze(clone(ticket))
}

function optionsObject(options) {
  if (!isObject(options)) throw new TypeError('options must be an object')
  return options
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function nullableText(value, name) {
  return value === undefined || value === null ? null : requiredText(value, name)
}

function detailText(value) {
  return value === undefined || value === null ? '' : String(value)
}

function eventAt(at) {
  return at === undefined ? new Date().toISOString() : requiredText(at, 'at')
}

function makeEvent(type, at, detail, eventId) {
  const event = { at, type, detail: detailText(detail) }
  if (eventId !== undefined) event.eventId = requiredText(eventId, 'eventId')
  return event
}

function assertTicket(ticket) {
  if (!isObject(ticket)) throw new TypeError('ticket must be an object')
  requiredText(ticket.id, 'ticket.id')
  requiredText(ticket.threadKey, 'ticket.threadKey')
  if (!STATUSES.has(ticket.status)) throw new TypeError(`unknown ticket status: ${ticket.status}`)
  if (!Array.isArray(ticket.history)) throw new TypeError('ticket.history must be an array')
  return ticket
}

function isDuplicate(ticket, eventId, type) {
  if (eventId === undefined) return false
  const id = requiredText(eventId, 'eventId')
  const previous = ticket.history.find((event) => event && event.eventId === id)
  if (!previous) return false
  if (previous.type !== type) throw new Error(`eventId ${id} was already consumed as ${previous.type}`)
  return true
}

function transition(ticket, type, options, changes, detail) {
  const at = eventAt(options.at)
  const event = makeEvent(type, at, detail, options.eventId)
  return deepFreeze({
    ...clone(ticket),
    ...changes,
    updatedAt: at,
    history: [...clone(ticket.history), event],
  })
}

export function create(fields = {}) {
  const source = optionsObject(fields)
  const threadKey = requiredText(source.threadKey, 'threadKey')
  const id = source.id === undefined ? `ticket:${threadKey}` : requiredText(source.id, 'id')
  const at = eventAt(source.at)
  return deepFreeze({
    id,
    threadKey,
    status: 'open',
    ownerSessionId: null,
    workdir: null,
    assignmentId: null,
    resumeCount: 0,
    createdAt: at,
    updatedAt: at,
    endedAt: null,
    endReason: null,
    history: [makeEvent('created', at, source.detail, source.eventId)],
  })
}

export function assign(ticket, options = {}) {
  const state = assertTicket(ticket)
  const source = optionsObject(options)
  const sessionId = requiredText(source.sessionId ?? source.ownerSessionId, 'sessionId')
  const assignmentId = requiredText(source.assignmentId, 'assignmentId')
  const workdir = nullableText(source.workdir, 'workdir')
  if (isDuplicate(state, source.eventId, 'assigned')) return unchanged(state)
  if (state.status === 'ended') throw new Error('cannot assign an ended ticket; human resume is required')
  if (state.status === 'assigned'
    && state.ownerSessionId === sessionId
    && state.assignmentId === assignmentId
    && state.workdir === workdir) return unchanged(state)

  return transition(state, 'assigned', source, {
    status: 'assigned',
    ownerSessionId: sessionId,
    workdir,
    assignmentId,
    endedAt: null,
    endReason: null,
  }, source.detail)
}

export function wait(ticket, options = {}) {
  const state = assertTicket(ticket)
  const source = optionsObject(options)
  if (isDuplicate(state, source.eventId, 'waiting')) return unchanged(state)
  if (state.status === 'waiting') return unchanged(state)
  if (state.status !== 'assigned') throw new Error(`cannot wait a ${state.status} ticket; assigned status is required`)
  return transition(state, 'waiting', source, { status: 'waiting' }, source.detail ?? source.reason)
}

export function end(ticket, options = {}) {
  const state = assertTicket(ticket)
  const source = optionsObject(options)
  if (isDuplicate(state, source.eventId, 'ended')) return unchanged(state)
  if (state.status === 'ended') return unchanged(state)
  const endReason = source.reason === undefined || source.reason === null
    ? (source.detail === undefined || source.detail === null ? null : String(source.detail))
    : String(source.reason)
  const at = eventAt(source.at)
  return transition(state, 'ended', { ...source, at }, {
    status: 'ended',
    endedAt: at,
    endReason,
  }, source.detail ?? source.reason)
}

export function resume(ticket, options = {}) {
  const state = assertTicket(ticket)
  const source = optionsObject(options)
  if (source.actor !== 'human') throw new Error('resume requires explicit actor: human')
  if (isDuplicate(state, source.eventId, 'resumed')) return unchanged(state)
  if (state.status !== 'ended') throw new Error(`cannot resume a ${state.status} ticket; ended status is required`)
  return transition(state, 'resumed', source, {
    status: 'open',
    ownerSessionId: null,
    workdir: null,
    assignmentId: null,
    resumeCount: (Number(state.resumeCount) || 0) + 1,
    endedAt: null,
    endReason: null,
  }, source.detail)
}

export function history(ticket) {
  return deepFreeze(clone(assertTicket(ticket).history))
}
