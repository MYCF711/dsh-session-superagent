/**
 * Ticket / 执行 / 部署只读投影。
 *
 * 这里只读取共享 DTO，不拥有生命周期状态，也不暴露可回写的内部对象。
 * 未提供的集合与计数是 null；调用方显式给出空数组或空对象时计数才是 0。
 */

const TICKET_STATUSES = ['open', 'assigned', 'waiting', 'ended']
const ASSIGNMENT_STATUSES = ['assigned', 'waiting', 'ended']
const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'failed', 'gone']
const HEALTH_STATES = ['ready', 'error', 'starting', 'paused']

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!isRecord(value)) return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child)
  return copy
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function nullableText(value) {
  return typeof value === 'string' && value ? value : null
}

function nullableCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function unknownCounts(names) {
  return Object.fromEntries(names.map((name) => [name, null]))
}

function zeroCounts(names) {
  return Object.fromEntries(names.map((name) => [name, 0]))
}

function collection(input, key) {
  if (Array.isArray(input)) {
    return key === 'tickets' ? { known: true, items: input } : { known: false, items: [] }
  }
  if (!isRecord(input) || !hasOwn(input, key)) return { known: false, items: [] }
  const value = input[key]
  if (Array.isArray(value)) return { known: true, items: value }
  if (isRecord(value)) return { known: true, items: Object.values(value) }
  return { known: false, items: [] }
}

/** 投影单个 Ticket；history 被复制并冻结，不与原状态共享引用。 */
export function projectTicketRecord(ticket) {
  const source = isRecord(ticket) ? ticket : {}
  const history = Array.isArray(source.history) ? cloneValue(source.history) : null
  return deepFreeze({
    id: nullableText(source.id),
    threadKey: nullableText(source.threadKey),
    status: TICKET_STATUSES.includes(source.status) ? source.status : null,
    ownerSessionId: nullableText(source.ownerSessionId),
    workdir: nullableText(source.workdir),
    assignmentId: nullableText(source.assignmentId),
    resumeCount: nullableCount(source.resumeCount),
    createdAt: nullableText(source.createdAt),
    updatedAt: nullableText(source.updatedAt),
    endedAt: nullableText(source.endedAt),
    endReason: nullableText(source.endReason),
    history,
    historyCount: history ? history.length : null,
  })
}

/**
 * Ticket records 列表与状态计数。
 * 接受 Ticket[]、{ tickets: Ticket[] } 或 { tickets: Record<id, Ticket> }。
 */
export function projectTicketRecords(input) {
  const { known, items } = collection(input, 'tickets')
  if (!known) {
    return deepFreeze({ records: null, total: null, counts: unknownCounts(TICKET_STATUSES) })
  }
  const counts = zeroCounts(TICKET_STATUSES)
  for (const ticket of items) {
    if (isRecord(ticket) && TICKET_STATUSES.includes(ticket.status)) counts[ticket.status] += 1
  }
  return deepFreeze({
    records: items.map(projectTicketRecord),
    total: items.length,
    counts,
  })
}

function projectSubscriptionRecord(subscription) {
  const source = isRecord(subscription) ? subscription : {}
  return deepFreeze({
    threadKey: nullableText(source.threadKey),
    ticketId: nullableText(source.ticketId),
    sessionId: nullableText(source.sessionId),
    active: typeof source.active === 'boolean' ? source.active : null,
    createdAt: nullableText(source.createdAt),
  })
}

function projectSubscriptions(input) {
  const { known, items } = collection(input, 'subscriptions')
  if (!known) return deepFreeze({ records: null, total: null, active: null, inactive: null })
  const records = items.map(projectSubscriptionRecord)
  const active = records.filter((record) => record.active === true).length
  const inactive = records.filter((record) => record.active === false).length
  return deepFreeze({ records, total: records.length, active, inactive })
}

function projectOutboxRecord(message) {
  const source = isRecord(message) ? message : {}
  return deepFreeze({
    id: nullableText(source.id),
    ticketId: nullableText(source.ticketId),
    channel: source.channel === undefined ? null : cloneValue(source.channel),
    body: typeof source.body === 'string' ? source.body : null,
    status: OUTBOX_STATUSES.includes(source.status) ? source.status : null,
    attempts: nullableCount(source.attempts),
    nextAt: nullableText(source.nextAt),
    createdAt: nullableText(source.createdAt),
    updatedAt: nullableText(source.updatedAt),
  })
}

function projectOutbox(input) {
  const { known, items } = collection(input, 'outbox')
  if (!known) {
    return deepFreeze({ records: null, total: null, counts: unknownCounts(OUTBOX_STATUSES) })
  }
  const counts = zeroCounts(OUTBOX_STATUSES)
  const records = items.map((message) => {
    const record = projectOutboxRecord(message)
    if (record.status) counts[record.status] += 1
    return record
  })
  return deepFreeze({ records, total: records.length, counts })
}

function projectAssignmentRecord(assignment) {
  const source = isRecord(assignment) ? assignment : {}
  return deepFreeze({
    id: nullableText(source.id),
    ticketId: nullableText(source.ticketId),
    sessionId: nullableText(source.sessionId),
    workdir: nullableText(source.workdir),
    status: ASSIGNMENT_STATUSES.includes(source.status) ? source.status : null,
    attempts: nullableCount(source.attempts),
  })
}

function projectAssignments(input) {
  const { known, items } = collection(input, 'assignments')
  if (!known) {
    return deepFreeze({ records: null, total: null, counts: unknownCounts(ASSIGNMENT_STATUSES) })
  }
  const counts = zeroCounts(ASSIGNMENT_STATUSES)
  const records = items.map((assignment) => {
    const record = projectAssignmentRecord(assignment)
    if (record.status) counts[record.status] += 1
    return record
  })
  return deepFreeze({ records, total: records.length, counts })
}

/**
 * records 路由统一投影：顶层 records/total/counts 属于 Tickets，其余集合保留各自命名。
 * 所有集合都遵守“缺省未知为 null、显式空集合计数为 0”。
 */
export function projectRecords(input) {
  return deepFreeze({
    ...projectTicketRecords(input),
    subscriptions: projectSubscriptions(input),
    assignments: projectAssignments(input),
    outbox: projectOutbox(input),
  })
}

function currentTicket(source, tickets) {
  if (hasOwn(source, 'current')) {
    const current = isRecord(source.current) && isRecord(source.current.ticket)
      ? source.current.ticket
      : source.current
    return isRecord(current) ? current : null
  }
  if (hasOwn(source, 'currentTicket')) return isRecord(source.currentTicket) ? source.currentTicket : null
  if (hasOwn(source, 'currentTicketId')) {
    if (source.currentTicketId == null) return null
    return tickets.find((ticket) => isRecord(ticket) && ticket.id === source.currentTicketId) || null
  }
  if (hasOwn(source, 'currentAssignmentId')) {
    if (source.currentAssignmentId == null) return null
    return tickets.find((ticket) => isRecord(ticket) && ticket.assignmentId === source.currentAssignmentId) || null
  }
  return tickets.find((ticket) => isRecord(ticket) && ticket.status === 'assigned') || null
}

function currentAssignment(source, current, assignments) {
  if (isRecord(source.current) && hasOwn(source.current, 'assignment')) {
    return isRecord(source.current.assignment) ? source.current.assignment : null
  }
  if (hasOwn(source, 'currentAssignment')) return isRecord(source.currentAssignment) ? source.currentAssignment : null
  const id = hasOwn(source, 'currentAssignmentId')
    ? source.currentAssignmentId
    : (isRecord(current) ? current.assignmentId : null)
  if (id != null) {
    return assignments.find((assignment) => isRecord(assignment) && assignment.id === id) || null
  }
  if (hasOwn(source, 'currentAssignmentId') || hasOwn(source, 'currentAssignment')) return null
  return assignments.find((assignment) => isRecord(assignment) && assignment.status === 'assigned') || null
}

function loadCount(source, known, name, fallback) {
  if (isRecord(source.load) && hasOwn(source.load, name)) return nullableCount(source.load[name])
  return known ? fallback : null
}

/**
 * 当前执行摘要。未显式指定 current 时，优先取首个 assigned Ticket / Assignment。
 * running 优先使用 load，其次使用 Assignment 计数，最后才由 assigned Ticket 推导。
 */
export function projectExecution(input) {
  const source = isRecord(input) ? input : {}
  const tickets = collection(input, 'tickets')
  const assignments = collection(input, 'assignments')
  const records = projectRecords(input)
  const current = currentTicket(source, tickets.items)
  const assignment = currentAssignment(source, current, assignments.items)
  const activeCount = tickets.known ? records.total - records.counts.ended : null
  const runningFallback = assignments.known ? records.assignments.counts.assigned : records.counts.assigned
  return deepFreeze({
    current: current ? projectTicketRecord(current) : null,
    assignment: assignment ? projectAssignmentRecord(assignment) : null,
    total: records.total,
    activeCount,
    counts: cloneValue(records.counts),
    subscriptions: records.subscriptions,
    assignments: records.assignments,
    outbox: records.outbox,
    running: loadCount(source, tickets.known || assignments.known, 'running', runningFallback),
    queued: loadCount(source, tickets.known, 'queued', records.counts.open),
    maxWorkers: isRecord(source.load) && hasOwn(source.load, 'maxWorkers')
      ? nullableCount(source.load.maxWorkers)
      : null,
    paused: typeof source.paused === 'boolean' ? source.paused : null,
  })
}

function healthCollection(input) {
  if (!isRecord(input) || !hasOwn(input, 'health')) return { known: false, entries: [] }
  if (Array.isArray(input.health)) {
    return {
      known: true,
      entries: input.health.map((entry, index) => [isRecord(entry) && entry.name != null ? String(entry.name) : String(index), entry]),
    }
  }
  if (isRecord(input.health)) return { known: true, entries: Object.entries(input.health) }
  return { known: false, entries: [] }
}

function projectHealthEntry(name, entry) {
  const source = isRecord(entry) ? entry : {}
  return {
    name: nullableText(name),
    state: HEALTH_STATES.includes(source.state) ? source.state : null,
    code: nullableText(source.code),
    detail: nullableText(source.detail),
    values: source.values === undefined ? null : cloneValue(source.values),
    at: nullableText(source.at),
  }
}

/** 部署问题与健康摘要；health={} 是明确健康项为空，health 缺省则是未知。 */
export function projectDeployment(input) {
  const source = isRecord(input) ? input : {}
  const setup = isRecord(source.setup) ? source.setup : {}
  const problem = source.problem !== undefined ? source.problem : setup.problem
  const stateDir = source.stateDir !== undefined
    ? source.stateDir
    : (isRecord(setup.machine) ? setup.machine.stateDir : undefined)
  const { known, entries } = healthCollection(source)

  if (!known) {
    return deepFreeze({
      status: problem ? 'error' : 'unknown',
      stateDir: nullableText(stateDir),
      problem: problem == null ? null : cloneValue(problem),
      health: null,
      counts: unknownCounts(['total', ...HEALTH_STATES, 'unknown']),
    })
  }

  const counts = zeroCounts(['total', ...HEALTH_STATES, 'unknown'])
  counts.total = entries.length
  const health = entries.map(([name, entry]) => {
    const view = projectHealthEntry(name, entry)
    counts[view.state || 'unknown'] += 1
    return view
  })
  const status = problem || counts.error > 0 ? 'error'
    : counts.unknown > 0 ? 'unknown'
      : counts.starting > 0 ? 'starting'
        : counts.paused > 0 ? 'paused'
          : 'ready'

  return deepFreeze({
    status,
    stateDir: nullableText(stateDir),
    problem: problem == null ? null : cloneValue(problem),
    health,
    counts,
  })
}
