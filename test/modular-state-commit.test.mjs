import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

async function load(name) {
  const dir = tempDir('zhuli-modular-state-')
  process.env.DSH_SUPERAGENT_STATE = dir
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  assertTempStateDir(name)
  return import('../lib/index.js?' + name + '=' + Date.now())
}

test('模块化 CAS 在锁内基于最新快照提交，watcher 写入不回滚 Ticket', async () => {
  const mod = await load('modular-cas')
  const first = mod.__test.commitModularState(0, (disk) => ({ ...disk, tickets: { t1: { id: 't1', status: 'open' } } }))
  assert.equal(first.modularVersion, 1)
  assert.equal(first.writeError, undefined)

  const stale = mod.__test.readState()
  const second = mod.__test.commitModularState(1, (disk) => ({ ...disk, outbox: { messages: { m1: { id: 'm1' } } } }))
  assert.equal(second.modularVersion, 2)
  assert.deepEqual(Object.keys(second.tickets), ['t1'])

  stale.watchers = { 'o/r#s': { id: 'o/r#s', repo: 'o/r', sessionId: 's', enabled: false } }
  const written = mod.__test.writeState(stale)
  assert.equal(written.modularVersion, 2)
  assert.deepEqual(Object.keys(written.outbox.messages), ['m1'])
  assert.equal(written.watchers['o/r#s'].enabled, false)
  const disk = mod.__test.readState()
  assert.equal(disk.modularVersion, 2)
  assert.equal(disk.watchers['o/r#s'].enabled, false)
})

test('模块化 CAS 冲突显式可见且不写盘', async () => {
  const mod = await load('modular-conflict')
  mod.__test.commitModularState(0, (disk) => ({ ...disk, tickets: { kept: { id: 'kept' } } }))
  const conflict = mod.__test.commitModularState(0, (disk) => ({ ...disk, tickets: { lost: { id: 'lost' } } }))
  assert.match(conflict.writeError.message, /MODULAR_CAS_CONFLICT|CAS conflict/)
  const disk = mod.__test.readState()
  assert.equal(disk.modularVersion, 1)
  assert.deepEqual(Object.keys(disk.tickets), ['kept'])
})
