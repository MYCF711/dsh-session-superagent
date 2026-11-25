/** 单用户模块化运行时：组合 Ticket/订阅/Assignment/Admission，不直接写宿主或 Outbox。 */
import { create as createTicket, resume as resumeTicket, end as endTicket } from './ticket-state.js'
import { createThreadSubscriptionState, subscribe, unsubscribe, syncTicketState, routeThreadEvent } from './thread-subscription.js'
import { planAssignment, startAssignment, promptAssignment, stopAssignment, transitionAssignment } from './execution-assignment.js'
import { workerSessionId } from './executor-host.js'
import { evaluateAdmission } from './admission-eval.js'
import { projectRecords, projectExecution, projectDeployment } from './ticket-projection.js'
import { createPromptConfig } from './prompt-config.js'
import { createI18n, normalizeLanguage } from './i18n.js'

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function required(value, name) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(`${name} is required`)
  return text
}

export function runtimeThreadKey({ provider = 'github', repo, number } = {}) {
  return `${provider}:${required(repo, 'repo')}#${required(number, 'number')}`
}

export function runtimeTicketId(threadKey) {
  return `ticket:${required(threadKey, 'threadKey')}`
}

export function createModularRuntimeState(fields = {}) {
  const source = isObject(fields) ? fields : {}
  return {
    ...source,
    tickets: isObject(source.tickets) ? { ...source.tickets } : {},
    subscriptions: createThreadSubscriptionState(source.subscriptions),
    assignments: isObject(source.assignments) ? { ...source.assignments } : {},
    promptConfig: createPromptConfig(source.promptConfig),
    locale: normalizeLanguage(source.locale),
  }
}

function latestAssignment(state, ticket) {
  if (ticket.assignmentId && state.assignments[ticket.assignmentId]) return state.assignments[ticket.assignmentId]
  const rows = Object.values(state.assignments).filter((row) => row.ticketId === ticket.id)
  return rows.filter((row) => row.status !== 'ended').at(-1) || rows.at(-1) || null
}

function commitTicketView(state, { ticket, assignment, subscriptions }) {
  return {
    ...state,
    tickets: { ...state.tickets, [ticket.id]: ticket },
    assignments: { ...state.assignments, [assignment.id]: assignment },
    subscriptions,
  }
}

/** 创建或复用 Ticket 与 Assignment；纯规划，不启动 Executor。 */
export function ensureTicket(input, spec = {}) {
  const state = createModularRuntimeState(input)
  const mode = spec.mode === 'worker' ? 'worker' : 'inline'
  const threadKey = spec.threadKey || runtimeThreadKey(spec)
  const ticketId = runtimeTicketId(threadKey)
  const previous = state.tickets[ticketId] || null
  if (previous && previous.status === 'ended') {
    return { state, ticket: previous, assignment: latestAssignment(state, previous), action: 'ended', mode }
  }
  const created = previous || createTicket({ id: ticketId, threadKey, at: spec.at, eventId: spec.eventId ? `${spec.eventId}:create` : undefined, detail: spec.detail })
  const sessionId = mode === 'worker' ? workerSessionId(ticketId) : required(spec.sessionId, 'sessionId')
  const workdir = spec.workdir || previous && previous.workdir
  const planned = planAssignment({
    ticket: created,
    assignment: latestAssignment(state, created),
    sessionId, workdir,
    retry: spec.retry === true,
    at: spec.at, eventId: spec.eventId ? `${spec.eventId}:assign` : undefined, detail: spec.detail,
  })
  let subscriptions = state.subscriptions
  const active = subscriptions.subscriptions[threadKey]
  if (active && active.active === true
    && (active.ticketId !== ticketId || active.sessionId !== planned.assignment.sessionId)) {
    subscriptions = unsubscribe(subscriptions, threadKey)
  }
  subscriptions = subscribe(subscriptions, {
    threadKey, ticketId, sessionId: planned.assignment.sessionId,
    ticketStatus: planned.ticket.status, endReason: planned.ticket.endReason,
    at: spec.at,
  })
  subscriptions = syncTicketState(subscriptions, threadKey, {
    status: planned.ticket.status, endReason: planned.ticket.endReason,
  })
  return {
    state: commitTicketView(state, { ...planned, subscriptions }),
    ticket: planned.ticket,
    assignment: planned.assignment,
    action: previous ? planned.action : 'start',
    mode,
  }
}

/** 只有显式 worker 才会触达 Executor；inline 调用直接拒绝，避免无意换执行体。 */
export async function startRuntimeAssignment(input, { ticketId, executor, prompt, messageId } = {}) {
  const state = createModularRuntimeState(input)
  const ticket = state.tickets[required(ticketId, 'ticketId')]
  if (!ticket) throw new Error(`ticket not found: ${ticketId}`)
  const assignment = latestAssignment(state, ticket)
  if (!assignment) throw new Error(`assignment not found: ${ticketId}`)
  if (assignment.sessionId !== workerSessionId(ticket.id)) throw new Error('startRuntimeAssignment requires an explicit worker assignment')
  const started = await startAssignment({ executor, ticket, assignment })
  const prompted = prompt === undefined ? null : await promptAssignment({ executor, ticket, assignment, prompt, messageId })
  return { state, ticket, assignment, receipt: started.receipt, promptReceipt: prompted && prompted.receipt }
}

/** 路由后续事件；worker 的外部副作用由显式 executor 执行，返回值仍包含完整新状态。 */
export async function routeRuntimeEvent(input, event = {}, options = {}) {
  const state = createModularRuntimeState(input)
  const mode = options.mode === 'worker' ? 'worker' : 'inline'
  const routed = routeThreadEvent(state.subscriptions, event)
  let next = { ...state, subscriptions: routed.state }
  let ticket = routed.ticketId
    ? next.tickets[routed.ticketId] || null
    : next.tickets[runtimeTicketId(routed.threadKey)] || null
  let assignment = ticket ? latestAssignment(next, ticket) : null

  if (routed.disposition === 'deliver' && ticket && assignment && assignment.status !== 'ended') {
    const currentMode = String(assignment.sessionId).startsWith('worker-') ? 'worker' : 'inline'
    if (currentMode !== mode) {
      let previous = assignment
      if (currentMode === 'worker') {
        if (!options.executor) throw new Error('worker-to-inline requires executor to stop the old worker')
        previous = (await stopAssignment({ executor: options.executor, ticket, assignment, reason: 'execution-mode-changed' })).assignment
      } else {
        previous = transitionAssignment(assignment, 'ended')
      }
      next = { ...next, assignments: { ...next.assignments, [previous.id]: previous } }
      const replanned = ensureTicket(next, {
        threadKey: ticket.threadKey,
        sessionId: options.sessionId || ticket.ownerSessionId,
        workdir: options.workdir || ticket.workdir,
        mode, at: event.at, eventId: routed.eventId,
      })
      next = replanned.state
      ticket = replanned.ticket
      assignment = replanned.assignment
    }
  }

  if (routed.disposition === 'resume' && ticket) {
    const resumed = resumeTicket(ticket, {
      actor: 'human', at: event.at, eventId: routed.eventId ? `${routed.eventId}:resume` : undefined, detail: event.body || event.detail,
    })
    // 先显式写入 resumed，再规划下一派工，不能让旧 ended Ticket 被普通评论直接 assign。
    next = { ...next, tickets: { ...next.tickets, [ticket.id]: resumed } }
    const replanned = ensureTicket(next, {
      threadKey: ticket.threadKey,
      sessionId: options.sessionId || ticket.ownerSessionId,
      workdir: options.workdir || ticket.workdir,
      mode, at: event.at, eventId: routed.eventId,
    })
    next = replanned.state
    ticket = replanned.ticket
    assignment = replanned.assignment
  }

  if (mode === 'worker' && !options.deferExecution && (routed.disposition === 'deliver' || routed.disposition === 'resume') && ticket && assignment) {
    await startRuntimeAssignment(next, {
      ticketId: ticket.id,
      executor: options.executor,
      prompt: event.body || event.detail || 'continue',
      messageId: routed.eventId,
    })
  }
  return { state: next, ticket, assignment, disposition: routed.disposition, reason: routed.reason }
}

/** 完成 Ticket；worker 可显式停止宿主执行体，inline 只写状态。 */
export async function completeRuntimeTicket(input, ticketId, options = {}) {
  const state = createModularRuntimeState(input)
  const ticket = state.tickets[required(ticketId, 'ticketId')]
  if (!ticket) throw new Error(`ticket not found: ${ticketId}`)
  const assignment = latestAssignment(state, ticket)
  const reason = options.reason || 'completed'
  let nextAssignment = assignment
  if (assignment && assignment.status !== 'ended') {
    nextAssignment = options.mode === 'worker'
      ? (await stopAssignment({ executor: options.executor, ticket, assignment, reason })).assignment
      : transitionAssignment(assignment, 'ended')
  }
  const ended = endTicket(ticket, {
    at: options.at, eventId: options.eventId, reason, detail: options.detail,
  })
  const subscriptions = syncTicketState(state.subscriptions, ticket.threadKey, { status: 'ended', endReason: reason })
  return {
    state: {
      ...state,
      tickets: { ...state.tickets, [ticket.id]: ended },
      assignments: nextAssignment ? { ...state.assignments, [nextAssignment.id]: nextAssignment } : state.assignments,
      subscriptions,
    },
    ticket: ended,
    assignment: nextAssignment,
  }
}

export function projectRuntime(input, healthOptions = {}) {
  const state = createModularRuntimeState(input)
  const subscriptions = state.subscriptions.subscriptions
  const outbox = state.outbox && Array.isArray(state.outbox.outbox) ? state.outbox.outbox : state.outbox
  return {
    records: projectRecords({ tickets: state.tickets, subscriptions, assignments: state.assignments, outbox }),
    execution: projectExecution({ tickets: state.tickets, subscriptions, assignments: state.assignments, outbox, ...healthOptions, paused: state.executorPaused === true || healthOptions.paused }),
    deployment: projectDeployment(healthOptions),
    draft: state.draft || null,
    actions: true,
    locale: state.locale,
  }
}

export function renderRuntimePrompt(key, values, options = {}) {
  const config = createPromptConfig(options.promptConfig)
  return createI18n(config, { language: options.locale }).t(key, values)
}

export { evaluateAdmission }
