import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tempDir } from './fixtures/tmpdir.mjs'

function writer(stateDir, moduleUrl, owner, count) {
  const source = `
    const mod = await import(${JSON.stringify(moduleUrl)} + '?writer=' + ${JSON.stringify(owner)})
    for (let index = 0; index < ${count}; index += 1) {
      const state = mod.__test.readState()
      state.watchers[${JSON.stringify(owner)} + '/' + index + '#s'] = {
        repo: ${JSON.stringify(owner)} + '/' + index, sessionId: 's', enabled: true,
      }
      const written = mod.__test.writeState(state)
      if (written && written.writeError) throw new Error(written.writeError.message)
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DSH_SUPERAGENT_STATE: stateDir, DSH_SUPERAGENT_NO_POLL: '1', DSH_SUPERAGENT_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('writer exit ' + code + ': ' + stderr)))
  })
}

test('状态写锁：两个独立进程并发写，50 条 watcher 全保留且无锁残留', async () => {
  const stateDir = tempDir('zhuli-write-lock-')
  writeFileSync(join(stateDir, 'watchers.json'), JSON.stringify({ watchers: {} }))
  const moduleUrl = pathToFileURL(join(process.cwd(), 'lib/index.js')).href
  await Promise.all([
    writer(stateDir, moduleUrl, 'o/a', 25),
    writer(stateDir, moduleUrl, 'o/b', 25),
  ])
  const state = JSON.parse(readFileSync(join(stateDir, 'watchers.json'), 'utf8'))
  assert.equal(Object.keys(state.watchers).length, 50)
  assert.equal(Object.values(state.watchers).every((entry) => entry.watermarkVersion === 2), true)
  assert.equal(existsSync(join(stateDir, 'watchers.json.lock')), false)
})
