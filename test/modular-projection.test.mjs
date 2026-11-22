import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

test('模块化投影解包 Thread/Outbox，显式空集合不是未知', async () => {
  const dir = tempDir('zhuli-modular-projection-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  assertTempStateDir('modular-projection')
  const mod = await import('../lib/index.js?modular-projection=' + Date.now())
  mod.__test.commitModularState(0, (disk) => ({
    ...disk,
    tickets: { t1: { id: 't1', threadKey: 'github:o/r#1', status: 'open', history: [] } },
    subscriptions: { subscriptions: { 'github:o/r#1': { threadKey: 'github:o/r#1', ticketId: 't1', sessionId: 's', active: true } }, seenEvents: {} },
    outbox: { outboxVersion: 1, revision: 0, outbox: [] },
  }))
  const view = mod.__test.projectModular(mod.__test.readState())
  assert.equal(view.records.total, 1)
  assert.equal(view.records.subscriptions.active, 1)
  assert.equal(view.records.outbox.total, 0)
  assert.equal(view.records.outbox.counts.pending, 0)
  assert.equal(view.execution.counts.open, 1)
  assert.equal(view.locale, 'zh')
})
