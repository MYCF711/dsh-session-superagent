import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-outbox-marker-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
assertTempStateDir('outbox-marker')

test('Outbox marker 可恢复查重且不污染可见正文', async () => {
  process.env.DSH_SUPERAGENT_NO_POLL = '1'
  process.env.DSH_SUPERAGENT_OFFLINE = '1'
  const mod = await import('../lib/index.js?outbox-marker=' + Date.now())
  const marker = mod.__test.outboxMarker('outbox:abc_1-2')
  assert.equal(marker, '<!-- dsh-outbox:outbox:abc_1-2 -->')
  const body = mod.__test.withOutboxMarker('处理完成', 'outbox:abc_1-2')
  assert.ok(body.startsWith('处理完成\n\n<!--'))
  assert.equal(mod.__test.hasOutboxMarker(body, 'outbox:abc_1-2'), true)
  assert.equal(mod.__test.hasOutboxMarker('其它评论', 'outbox:abc_1-2'), false)
  assert.throws(() => mod.__test.outboxMarker('///'), /required/)
})

test('远端 Outbox marker 查重返回 found，读取失败显式失败', async () => {
  const mod = await import('../lib/index.js?outbox-marker-read=' + Date.now())
  const entry = { provider: 'github', repo: 'o/r' }
  const found = await mod.__test.findOutboxComment(entry, 7, 'issue', 'outbox:abc', {
    run: async () => ({ code: 0, stdout: JSON.stringify([{ body: 'ok\n\n<!-- dsh-outbox:outbox:abc -->' }]), stderr: '' }),
  })
  assert.deepEqual(found, { ok: true, found: true })
  const failed = await mod.__test.findOutboxComment(entry, 7, 'issue', 'outbox:abc', {
    run: async () => ({ code: 1, stdout: '', stderr: 'offline' }),
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /offline/)
})

test('GitHub/Gitee 第二页 marker 也能查重，不错判为未发送', async () => {
  const mod = await import('../lib/index.js?outbox-marker-pages=' + Date.now())
  const pages = []
  const run = async (_file, args) => {
    const page = Number((args.join(' ').match(/[?&]page=(\d+)/) || [])[1] || 1)
    pages.push(page)
    const body = page === 2 ? [{ body: '<!-- dsh-outbox:outbox:paged -->' }] : Array.from({ length: 100 }, () => ({ body: 'other' }))
    return { code: 0, stdout: JSON.stringify(body), stderr: '' }
  }
  const github = await mod.__test.findOutboxComment({ provider: 'github', repo: 'o/r' }, 7, 'issue', 'outbox:paged', { run })
  assert.deepEqual(github, { ok: true, found: true })
  assert.deepEqual(pages, [1, 2])

  const giteePages = []
  const gitee = await mod.__test.findOutboxComment({ provider: 'gitee', repo: 'o/r' }, 7, 'issue', 'outbox:paged', {
    fetchImpl: async (url) => {
      const page = Number((String(url).match(/[?&]page=(\d+)/) || [])[1] || 1)
      giteePages.push(page)
      const body = page === 2 ? [{ body: '<!-- dsh-outbox:outbox:paged -->' }] : Array.from({ length: 100 }, () => ({ body: 'other' }))
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    },
  })
  assert.deepEqual(gitee, { ok: true, found: true })
  assert.deepEqual(giteePages, [1, 2])
})
