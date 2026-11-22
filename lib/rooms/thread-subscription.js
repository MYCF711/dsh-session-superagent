/**
 * Thread 订阅房。
 *
 * 只维护 Thread → Ticket/session 归属与事件去重，不直接唤醒、投递或执行。
 * routeThreadEvent 返回 deliver / resume / eval / ignore 决策和新的持久化状态；
 * 宿主需在单写者事务中提交 state，才能跨重启保持幂等。
 */
export const THREAD_SUBSCRIPTION_VERSION = 1

const DISPOSITIONS = new Set(['deliver', 'resume', 'eval', 'ignore'])
const TICKET_STATUSES = new Set(['open', 'assigned', 'waiting', 'ended'])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value, name) {
  if (value === undefined || value === null) throw new TypeError(`${name} is required`)
  const text = String(value).trim()
  if (!text) throw new TypeError(`${name} is required`)
  return text
}

function eventAt(value) {
  return value === undefined ? new Date().toISOString() : requiredText(value, 'at')
}

function ticketStatus(value) {
  const status = value === undefined ? 'open' : requiredText(value, 'ticketStatus')
  if (!TICKET_STATUSES.has(status)) throw new TypeError(`unsupported ticketStatus: ${status}`)
  return status
}

function endReason(value, status) {
  if (status !== 'ended' || value === undefined || value === null) return null
  return requiredText(value, 'endReason')
}

function cloneSubscription(row) {
  return isObject(row) ? { ...row } : row
}

function cloneRoutedEvent(row) {
  return isObject(row) ? { ...row } : row
}

function cloneRows(rows, cloneRow) {
  if (!isObject(rows)) return {}
  return Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, cloneRow(row)]))
}

function assertVersion(version) {
  if (version !== undefined && version !== THREAD_SUBSCRIPTION_VERSION) {
    throw new Error(`threadSubscriptionVersion ${version} is newer than supported ${THREAD_SUBSCRIPTION_VERSION}`)
  }
}

export function createThreadSubscriptionState(fields = {}) {
  const source = isObject(fields) ? fields : {}
  assertVersion(source.threadSubscriptionVersion)
  return {
    ...source,
    threadSubscriptionVersion: THREAD_SUBSCRIPTION_VERSION,
    subscriptions: cloneRows(source.subscriptions, cloneSubscription),
    seenEvents: cloneRows(source.seenEvents, cloneRoutedEvent),
  }
}

function asState(input) {
  if (input === undefined || input === null) return createThreadSubscriptionState()
  if (!isObject(input)) throw new TypeError('state must be an object')
  assertVersion(input.threadSubscriptionVersion)
  return input.threadSubscriptionVersion === undefined ? createThreadSubscriptionState(input) : input
}

export function subscribe(input, spec = {}) {
  const state = asState(input)
  if (!isObject(spec)) throw new TypeError('subscription must be an object')
  const threadKey = requiredText(spec.threadKey, 'threadKey')
  const ticketId = requiredText(spec.ticketId, 'ticketId')
  const sessionId = requiredText(spec.sessionId, 'sessionId')
  const previous = isObject(state.subscriptions[threadKey]) ? state.subscriptions[threadKey] : null

  if (previous && previous.active === true) {
    if (previous.ticketId === ticketId && previous.sessionId === sessionId) return state
    throw new Error(`thread ${threadKey} already has an active subscription; unsubscribe before rebinding`)
  }

  const sameTicket = previous && previous.ticketId === ticketId
  const status = ticketStatus(spec.ticketStatus ?? (sameTicket ? previous.ticketStatus : undefined))
  const subscription = {
    threadKey,
    ticketId,
    sessionId,
    active: true,
    createdAt: eventAt(spec.at),
    ticketStatus: status,
    endReason: endReason(spec.endReason ?? (sameTicket ? previous.endReason : null), status),
  }
  return {
    ...state,
    subscriptions: { ...state.subscriptions, [threadKey]: subscription },
  }
}

export function unsubscribe(input, threadKey) {
  const state = asState(input)
  const key = requiredText(threadKey, 'threadKey')
  const previous = isObject(state.subscriptions[key]) ? state.subscriptions[key] : null
  if (!previous || previous.active !== true) return state
  return {
    ...state,
    subscriptions: {
      ...state.subscriptions,
      [key]: { ...previous, threadKey: key, active: false },
    },
  }
}

export function syncTicketState(input, threadKey, patch = {}) {
  const state = asState(input)
  const key = requiredText(threadKey, 'threadKey')
  if (!isObject(patch)) throw new TypeError('ticket patch must be an object')
  const previous = isObject(state.subscriptions[key]) ? state.subscriptions[key] : null
  if (!previous) throw new Error(`cannot sync ticket for unknown thread: ${key}`)
  const status = ticketStatus(requiredText(patch.status, 'status'))
  const reason = endReason(patch.endReason, status)
  if (previous.ticketStatus === status && (previous.endReason ?? null) === reason) return state
  return {
    ...state,
    subscriptions: {
      ...state.subscriptions,
      [key]: { ...previous, ticketStatus: status, endReason: reason },
    },
  }
}

function actorName(value) {
  if (typeof value === 'string') return value.trim().toLowerCase()
  if (isObject(value)) return actorName(value.type ?? value.kind ?? value.role)
  return ''
}

function isHumanEvent(event) {
  if (event.human === false) return false
  const actor = actorName(event.actor ?? event.actorType ?? event.source)
  // 非人 actor 优先于 human:true，冲突输入不得放大成执行生命周期操作。
  if (actor) return actor === 'human'
  return event.human === true
}

function isResumeRequested(event) {
  const kind = String(event.type ?? event.kind ?? event.action ?? '').trim().toLowerCase()
  return event.resume === true || kind === 'resume'
}

function eventIdentity(event) {
  const threadKey = requiredText(event.threadKey, 'event.threadKey')
  const eventId = requiredText(event.id ?? event.eventId, 'event.id')
  return { threadKey, eventId, key: JSON.stringify([threadKey, eventId]) }
}

function ownership(row) {
  return {
    ticketId: row && typeof row.ticketId === 'string' ? row.ticketId : null,
    sessionId: row && typeof row.sessionId === 'string' ? row.sessionId : null,
  }
}

function decision(disposition, identity, row, state, { duplicate = false, reason } = {}) {
  if (!DISPOSITIONS.has(disposition)) throw new Error(`unsupported thread event disposition: ${disposition}`)
  return {
    disposition,
    threadKey: identity.threadKey,
    eventId: identity.eventId,
    ...ownership(row),
    reason: reason || (duplicate ? 'duplicate-event' : 'subscribed-event'),
    duplicate,
    state,
  }
}

export function routeThreadEvent(input, event = {}) {
  const state = asState(input)
  if (!isObject(event)) throw new TypeError('event must be an object')
  const identity = eventIdentity(event)
  const previous = isObject(state.seenEvents[identity.key]) ? state.seenEvents[identity.key] : null
  if (previous) {
    // 去重优先于当前订阅：取消或换绑后重投旧事件也不能改投新主人。
    return decision('ignore', identity, previous, state, { duplicate: true })
  }

  const subscription = isObject(state.subscriptions[identity.threadKey])
    && state.subscriptions[identity.threadKey].active === true
    ? state.subscriptions[identity.threadKey]
    : null
  const human = isHumanEvent(event)
  const explicitResume = human && isResumeRequested(event)
  const ended = subscription && subscription.ticketStatus === 'ended'
  const humanStopped = ended && subscription.endReason === 'human-stop'

  let disposition
  let reason
  if (!subscription) {
    disposition = 'eval'
    reason = 'no-active-subscription'
  } else if (!ended) {
    // Ticket 只有 ended 才能 resume；其余状态的显式 resume 标记也仅作后续交付。
    disposition = 'deliver'
    reason = 'subscribed-event'
  } else if (explicitResume) {
    disposition = 'resume'
    reason = 'explicit-human-resume'
  } else if (humanStopped) {
    disposition = 'ignore'
    reason = 'human-stop'
  } else if (human) {
    disposition = 'resume'
    reason = 'ended-human-comment'
  } else {
    disposition = 'eval'
    reason = 'ended-non-human-event'
  }

  const routed = {
    disposition,
    threadKey: identity.threadKey,
    eventId: identity.eventId,
    ...ownership(subscription),
    reason,
  }
  const next = {
    ...state,
    seenEvents: { ...state.seenEvents, [identity.key]: routed },
  }
  return decision(disposition, identity, subscription, next, { reason })
}
