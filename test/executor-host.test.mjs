import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshExecutor, workerSessionId } from '../lib/rooms/executor-host.js'

function fixture() {
  const calls = []
  const agent = {
    id: 'worker-ticket:github:o/r#1', status: 'idle',
    followup(message) { calls.push(['followup', message]); this.status = 'running' },
    cancel(...args) { calls.push(['cancel', ...args]); return undefined },
  }
  const ctx = {
    sessionController: {
      async resolveAgent(id) {
        calls.push(['resolve', id])
        return calls.filter((call) => call[0] === 'create').length ? { agent } : { error: { code: 'session/not-found', message: 'missing' } }
      },
      async create(input) { calls.push(['create', input]); return {} },
    },
    workspaceRegistry: { async create(cwd) { calls.push(['workspace', cwd]); return { id: 'ws-1' } } },
  }
  return { calls, ctx }
}

test('executor-host 创建独立 worker session 并复用标准 preset', async () => {
  const { ctx, calls } = fixture()
  const executor = createDshExecutor(ctx)
  const ticket = { id: 'ticket:github:o/r#1' }
  const started = await executor.start({ ticket, assignment: { workdir: '/tmp/ticket-1' } })
  assert.equal(started.sessionId, 'worker-ticket:github:o/r#1')
  assert.equal(started.workdir, '/tmp/ticket-1')
  assert.ok(calls.some((call) => call[0] === 'workspace' && call[1] === '/tmp/ticket-1'))
  assert.ok(calls.some((call) => call[0] === 'create' && call[1].agentPreset === 'standard'))
  await executor.prompt({ ticket, prompt: 'continue', messageId: 'outbox:abc' })
  assert.equal(calls.at(-1)[0], 'followup')
  assert.equal(calls.at(-1)[1].id, 'outbox:abc')
  assert.equal((await executor.prompt({ ticket, prompt: 'busy probe' })).busy, true)
  assert.deepEqual(await executor.status({ ticket }), { sessionId: started.sessionId, status: 'assigned', hostStatus: 'running' })
  await executor.stop({ ticket, reason: 'done' })
  assert.equal(calls.at(-1)[0], 'cancel')
})

test('executor-host 缺能力和相对 workdir 显式失败，不回退当前 session', async () => {
  await assert.rejects(createDshExecutor({}).start({ ticket: { id: 't' }, assignment: { workdir: '/tmp/t' } }), /sessionController/)
  await assert.rejects(
    createDshExecutor({ sessionController: {}, workspaceRegistry: {} }).start({ ticket: { id: 't' }, assignment: { workdir: 'relative/t' } }),
    /absolute/,
  )
  assert.equal(workerSessionId('ticket:x'), 'worker-ticket:x')
})
