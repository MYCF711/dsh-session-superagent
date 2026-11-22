/** 单用户 Executor 的 DSH 宿主适配；无宿主能力时显式失败，不回退当前会话。 */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { redact } from '../redact.js'

export function workerSessionId(ticketId) {
  const id = String(ticketId || '').trim()
  if (!id) throw new TypeError('ticketId is required')
  return `worker-${id}`
}

function unwrap(result, sessionId) {
  if (result && result.agent) return result.agent
  const error = result && result.error
  const wrapped = new Error(error && error.message || `session not available: ${sessionId}`)
  wrapped.code = error && error.code || 'SESSION_UNAVAILABLE'
  throw wrapped
}

export function createDshExecutor(ctx = {}) {
  function requireHost(name) {
    const service = ctx[name]
    if (!service) throw new TypeError(`DSH host capability missing: ${name}`)
    return service
  }
  async function resolve(sessionId) {
    const controller = requireHost('sessionController')
    if (typeof controller.resolveAgent !== 'function') throw new TypeError('DSH host capability missing: sessionController.resolveAgent')
    return unwrap(await controller.resolveAgent(sessionId), sessionId)
  }
  return Object.freeze({
    async start({ ticket, assignment } = {}) {
      const workdir = String(assignment && assignment.workdir || ticket && ticket.workdir || '')
      if (!isAbsolute(workdir)) throw new TypeError('executor workdir must be absolute')
      const sessionId = workerSessionId(ticket && ticket.id)
      const controller = requireHost('sessionController')
      let result = await controller.resolveAgent(sessionId)
      if (result && result.error && result.error.code === 'session/not-found') {
        const registry = requireHost('workspaceRegistry')
        if (typeof registry.create !== 'function') throw new TypeError('DSH host capability missing: workspaceRegistry.create')
        const workspace = await registry.create(workdir)
        if (typeof controller.create !== 'function') throw new TypeError('DSH host capability missing: sessionController.create')
        await controller.create({ sessionId, workspaceId: workspace.id, agentPreset: 'standard' })
        result = await controller.resolveAgent(sessionId)
      }
      const agent = unwrap(result, sessionId)
      return { ok: true, sessionId: agent.id || sessionId, workdir }
    },
    async prompt({ ticket, prompt, messageId } = {}) {
      const sessionId = workerSessionId(ticket && ticket.id)
      const agent = await resolve(sessionId)
      if (agent.status && agent.status !== 'idle') return { ok: false, busy: true, error: `worker busy: ${agent.status}`, sessionId }
      const message = {
        id: messageId || randomUUID(), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: redact(String(prompt || '')) }],
      }
      if (typeof agent.followup === 'function') { await agent.followup(message); return { ok: true, via: 'followup', sessionId } }
      if (typeof agent.steer === 'function') { await agent.steer(message); return { ok: true, via: 'steer', sessionId } }
      const inbox = agent.inbox || agent.session && agent.session.inbox
      if (inbox && typeof inbox.append === 'function') {
        await inbox.append('next-turn', message)
        return { ok: true, via: 'inbox.append', sessionId }
      }
      throw new TypeError('worker session has no followup/steer/inbox delivery port')
    },
    async status({ ticket } = {}) {
      const sessionId = workerSessionId(ticket && ticket.id)
      const agent = await resolve(sessionId)
      const hostStatus = String(agent.status || '')
      const status = hostStatus === 'running' ? 'assigned' : hostStatus === 'idle' ? 'waiting' : hostStatus === 'ended' ? 'ended' : null
      if (!status) throw new TypeError(`unknown worker status: ${hostStatus || 'missing'}`)
      return { sessionId, status, hostStatus }
    },
    async stop({ ticket, reason = '' } = {}) {
      const sessionId = workerSessionId(ticket && ticket.id)
      const agent = await resolve(sessionId)
      if (typeof agent.cancel !== 'function') throw new TypeError('worker session has no cancel port')
      await agent.cancel({ kind: 'user', reason: String(reason) }, { keepInbox: true })
      return { ok: true, sessionId }
    },
  })
}
