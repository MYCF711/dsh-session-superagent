/**
 * 单用户执行房：规划 Ticket 的 Assignment，并通过宿主注入的 Executor 端口执行。
 *
 * 这里不创建 Session、工作区或子代理，也不回退到当前 Session。所有执行能力都必须
 * 由 ExecutorAdapter 显式提供；领域状态只有在端口明确成功后才推进。
 */
import { posix, win32 } from 'node:path'
import { assign as assignTicket } from './ticket-state.js'

const EXECUTOR_METHODS = Object.freeze(['start', 'prompt', 'status', 'stop'])
const ASSIGNMENT_STATUSES = new Set(['assigned', 'waiting', 'ended'])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

/** 同时识别 POSIX 与 Windows 绝对路径；不做依赖宿主编译平台的路径归一化。 */
export function assertAbsoluteWorkdir(workdir) {
  requiredText(workdir, 'workdir')
  if (workdir.includes('\0') || (!posix.isAbsolute(workdir) && !win32.isAbsolute(workdir))) {
    throw new TypeError('workdir must be an absolute path')
  }
  return workdir
}

/** Executor 是完整端口，任何能力缺失都显式失败，绝不静默换到别的执行体。 */
export function assertExecutorPort(executor) {
  if (!isObject(executor)) throw new TypeError('executor port is required')
  for (const method of EXECUTOR_METHODS) {
    if (typeof executor[method] !== 'function') {
      throw new TypeError(`executor port missing required method: ${method}`)
    }
  }
  return executor
}

export function assertAssignment(assignment) {
  if (!isObject(assignment)) throw new TypeError('assignment is required')
  requiredText(assignment.id, 'assignment.id')
  requiredText(assignment.ticketId, 'assignment.ticketId')
  requiredText(assignment.sessionId, 'assignment.sessionId')
  assertAbsoluteWorkdir(assignment.workdir)
  if (!ASSIGNMENT_STATUSES.has(assignment.status)) {
    throw new TypeError(`assignment.status must be one of: ${[...ASSIGNMENT_STATUSES].join(', ')}`)
  }
  positiveInteger(assignment.attempts, 'assignment.attempts')
  return assignment
}

/** 创建第 sequence 次派工；attempts 只属于这一个 Assignment，不从旧派工继承。 */
export function createAssignment({ ticketId, sessionId, workdir, sequence = 1, attempts = 1 } = {}) {
  requiredText(ticketId, 'ticketId')
  requiredText(sessionId, 'sessionId')
  positiveInteger(sequence, 'sequence')
  positiveInteger(attempts, 'attempts')
  return {
    id: `assign:${ticketId}:${sequence}`,
    ticketId,
    sessionId,
    workdir: assertAbsoluteWorkdir(workdir),
    status: 'assigned',
    attempts,
  }
}

/** 显式重试同一派工；ended 是不可原地重开的终态。 */
export function retryAssignment(assignment) {
  assertAssignment(assignment)
  if (assignment.status === 'ended') throw new Error('ended assignment cannot be retried; create a new assignment')
  if (assignment.attempts >= Number.MAX_SAFE_INTEGER) throw new RangeError('assignment.attempts cannot advance')
  return { ...assignment, status: 'assigned', attempts: assignment.attempts + 1 }
}

/** 应用 Executor 回报的状态，不修改输入，也不允许 ended 被状态轮询重新打开。 */
export function transitionAssignment(assignment, status) {
  assertAssignment(assignment)
  if (!ASSIGNMENT_STATUSES.has(status)) throw new TypeError(`unknown assignment status: ${String(status)}`)
  if (assignment.status === 'ended' && status !== 'ended') {
    throw new Error('ended assignment cannot transition back to an active status')
  }
  return assignment.status === status ? assignment : { ...assignment, status }
}

function nextSequence(assignment) {
  const match = /:(\d+)$/.exec(assignment.id)
  if (!match) throw new TypeError('sequence is required when the previous assignment id has no numeric suffix')
  const previous = Number(match[1])
  if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('assignment sequence cannot advance')
  }
  return previous + 1
}

/**
 * 纯规划：新派工返回 action=start；活跃派工默认原样复用，显式 retry 才增加 attempts。
 * 若 Ticket 已经由 ticket-state 的显式人工 resume 重新打开，旧 ended Assignment 不会
 * 原地复活，而是生成下一 sequence。Ticket 的状态写入仍只走 ticket-state 公开 API。
 */
export function planAssignment({
  ticket,
  assignment = null,
  sessionId,
  workdir,
  retry = false,
  sequence,
  at,
  eventId,
  detail,
} = {}) {
  if (!isObject(ticket)) throw new TypeError('ticket is required')
  const ticketId = requiredText(ticket.id, 'ticket.id')
  if (assignment !== null) {
    assertAssignment(assignment)
    if (assignment.ticketId !== ticketId) throw new TypeError('assignment.ticketId must match ticket.id')
  }
  if (typeof retry !== 'boolean') throw new TypeError('retry must be a boolean')

  const nextSessionId = requiredText(sessionId ?? assignment?.sessionId, 'sessionId')
  const nextWorkdir = assertAbsoluteWorkdir(workdir ?? assignment?.workdir)
  let nextAssignment
  let action

  if (assignment === null) {
    nextAssignment = createAssignment({
      ticketId,
      sessionId: nextSessionId,
      workdir: nextWorkdir,
      sequence: sequence ?? 1,
    })
    action = 'start'
  } else if (assignment.status === 'ended') {
    // assignTicket 会拒绝尚未经显式人工 resume 的 ended Ticket。
    nextAssignment = createAssignment({
      ticketId,
      sessionId: nextSessionId,
      workdir: nextWorkdir,
      sequence: sequence ?? nextSequence(assignment),
    })
    action = 'start'
  } else {
    if (nextSessionId !== assignment.sessionId) throw new TypeError('an active assignment cannot change sessionId')
    if (nextWorkdir !== assignment.workdir) throw new TypeError('an active assignment cannot change workdir')
    nextAssignment = retry ? retryAssignment(assignment) : assignment
    action = retry ? 'retry' : 'reuse'
  }

  let nextTicket = ticket
  if (action === 'reuse' && nextAssignment.status === 'waiting') {
    // 复用等待中的派工不等于重试，不能把 Ticket 悄悄激活。
    if (ticket.status !== 'waiting'
      || ticket.assignmentId !== nextAssignment.id
      || ticket.ownerSessionId !== nextAssignment.sessionId
      || ticket.workdir !== nextAssignment.workdir) {
      throw new Error('retry is required to reactivate a waiting assignment')
    }
  } else {
    nextTicket = assignTicket(ticket, {
      sessionId: nextAssignment.sessionId,
      workdir: nextAssignment.workdir,
      assignmentId: nextAssignment.id,
      at,
      eventId,
      detail,
    })
  }
  return { ticket: nextTicket, assignment: nextAssignment, action }
}

function executionContext(ticket, assignment) {
  if (!isObject(ticket)) throw new TypeError('ticket is required')
  requiredText(ticket.id, 'ticket.id')
  assertAssignment(assignment)
  if (assignment.ticketId !== ticket.id) throw new TypeError('assignment.ticketId must match ticket.id')
  return { ticket, assignment }
}

function assertActive(assignment) {
  if (assignment.status === 'ended') throw new Error('ended assignment cannot execute')
}

function assertSuccessfulReceipt(receipt, method) {
  if (isObject(receipt) && receipt.ok === false) {
    throw new Error(String(receipt.error || `executor ${method} was not acknowledged`))
  }
}

export async function startAssignment({ executor, ticket, assignment } = {}) {
  assertExecutorPort(executor)
  const context = executionContext(ticket, assignment)
  assertActive(assignment)
  const receipt = await executor.start(context)
  assertSuccessfulReceipt(receipt, 'start')
  return { ticket, assignment, receipt }
}

export async function promptAssignment({ executor, ticket, assignment, prompt, messageId } = {}) {
  assertExecutorPort(executor)
  const context = executionContext(ticket, assignment)
  assertActive(assignment)
  requiredText(prompt, 'prompt')
  const receipt = await executor.prompt({ ...context, prompt, messageId })
  assertSuccessfulReceipt(receipt, 'prompt')
  return { ticket, assignment, receipt }
}

function receiptStatus(receipt) {
  const status = typeof receipt === 'string' ? receipt : receipt?.status
  if (!ASSIGNMENT_STATUSES.has(status)) {
    throw new TypeError('executor status receipt must contain assigned, waiting, or ended')
  }
  return status
}

export async function statusAssignment({ executor, ticket, assignment } = {}) {
  assertExecutorPort(executor)
  const context = executionContext(ticket, assignment)
  const receipt = await executor.status(context)
  assertSuccessfulReceipt(receipt, 'status')
  const nextAssignment = transitionAssignment(assignment, receiptStatus(receipt))
  return { ticket, assignment: nextAssignment, receipt }
}

export async function stopAssignment({ executor, ticket, assignment, reason = 'stopped' } = {}) {
  assertExecutorPort(executor)
  const context = executionContext(ticket, assignment)
  requiredText(reason, 'reason')
  if (assignment.status === 'ended') return { ticket, assignment, receipt: null }
  const receipt = await executor.stop({ ...context, reason })
  assertSuccessfulReceipt(receipt, 'stop')
  return { ticket, assignment: transitionAssignment(assignment, 'ended'), receipt }
}
