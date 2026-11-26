// 唤醒文本里的图片（集成层）：issue 正文 / PR 评论里的截图 → 本地文件 + 绝对路径。
//
// 真机现场：issue 只贴了截图，处理会话只能回「拿不到图片内容」—— 因为唤醒消息是纯文本。
// 这一层要钉住四件事：
//   ① 真的要唤醒的那批条目，正文里的图**存到本地**，文本里给出可读的绝对路径；
//   ② 下载失败只降级：唤醒照常发，失败原因写清（不许编一个不存在的路径）；
//   ③ 不该下载的轮次一张图都不下（会话正忙时提前 return，别白走网络）；
//   ④ 附件入口的凭证只在第一跳出现（302 到 S3 之后必须消失）。
// 全程离线：fetch 由 deps 注入，不碰真实网络 / 真实状态目录。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

const STATE_DIR = tempDir('zhuli-image-wake-')
process.env.DSH_SUPERAGENT_STATE = STATE_DIR
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
process.env.DSH_SUPERAGENT_UPDATE_OFFLINE = '1'
assertTempStateDir('image-wake.test.mjs')

const mod = await import('../lib/index.js?image-wake=' + Date.now())
const { apply, __test } = mod
apply({
  tools: { register: () => {} },
  webServer: { register: () => () => {} },
  agents: { currentInitiator: () => ({ id: 'session-image' }), get: () => ({ status: 'idle' }) },
  get: () => null,
  effect: (fn) => fn(),
})

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const S3_URL = 'https://github-production-user-asset-6210df.s3.amazonaws.com/1/2/3.png?X-Amz-Signature=abc'

const pngResponse = () => new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })

/** 注入用的 fetch：记录 url / init，行为由 handler 决定。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  impl.calls = calls
  return impl
}

const headerOf = (call, name) => {
  for (const [key, value] of Object.entries((call && call.init && call.init.headers) || {})) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

const imageName = (url) => createHash('sha256').update(url).digest('hex').slice(0, 12) + '.png'

/** 捕获唤醒文本的假 wake（立即结算成功）。 */
function captureWake(sent) {
  return (ctx, sessionId, text, onSettled) => {
    sent.push({ sessionId, text })
    if (onSettled) onSettled({ ok: true })
  }
}

/**
 * 等唤醒结算落地（`settleWakeResult` 是异步的：里面还要登记 Ticket、写盘）。
 * 固定 sleep 会变成慢测；这里轮询到条件成立或超时，超时就断言失败（不许静默通过）。
 */
async function settled(check, label) {
  let ok = check()
  for (let i = 0; i < 200 && !ok; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    ok = check()
  }
  assert.ok(ok, '等不到唤醒结算：' + label)
}

const issue = (number, extra = {}) => ({
  number,
  title: '条目 ' + number,
  state: 'open',
  html_url: 'https://github.com/acme/repo/issues/' + number,
  updated_at: new Date().toISOString(),
  user: { login: 'octocat' },
  labels: [],
  assignees: [],
  ...extra,
})

const parsed = (items) => ({ status: 200, etag: null, body: JSON.stringify(items) })

const makeEntry = (extra = {}) => ({
  id: 'acme/repo#session-image',
  repo: 'acme/repo',
  provider: 'github',
  sessionId: 'session-image',
  intervalSec: 60,
  batchLimit: 5,
  enabled: true,
  observe: false,
  seen: {},
  cursor: null,
  filters: { labels: [], ignoreLabels: [], skipBots: false, skipDrafts: false, skipClosed: false },
  wakeTimes: [],
  history: [],
  ...extra,
})

/** pollWithItems 会回读盘上的条目（暂停/删除判定），所以先落盘。 */
function persist(entry) {
  const state = __test.readState()
  state.watchers = state.watchers || {}
  state.watchers[entry.id] = entry
  __test.writeState(state)
  return entry
}

// ─────────────────────────────────────────────────────────────────────────────
// issue 轮询
// ─────────────────────────────────────────────────────────────────────────────

test('issue 正文里的图会存成本地文件，唤醒文本给出 read_image 的绝对路径', async () => {
  const url = 'https://user-images.githubusercontent.com/1/shot.png'
  const sent = []
  const fetchImpl = fakeFetch(() => pngResponse())
  const entry = persist(makeEntry({ id: 'acme/repo#session-image', seen: {} }))
  await __test.pollWithItems(ctxOf({ status: 'idle' }), entry, 60000, parsed([
    issue(7, { body: '复现步骤见截图\n\n![截图](' + url + ' "标题")' }),
  ]), null, { wake: captureWake(sent), fetchImpl })

  assert.equal(sent.length, 1, '必须真的发出去一次')
  const text = sent[0].text
  const dir = join(STATE_DIR, 'images', 'acme-repo', 'issue-7')
  const path = join(dir, imageName(url))
  assert.ok(text.includes(path), '唤醒文本要给绝对路径：' + path + '\n---\n' + text)
  assert.match(text, /【图片】#7 有 1 张图已存本地，用 read_image 读取：/)
  assert.equal(existsSync(path), true, '路径必须真实存在（模型会拿它去读）')
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, url)
})

test('issue 正文只有非白名单图片：唤醒照发，只说下载失败原因，不编路径', async () => {
  const sent = []
  const fetchImpl = fakeFetch(() => pngResponse())
  const entry = persist(makeEntry({ id: 'acme/repo#nonwhitelist', seen: {} }))
  await __test.pollWithItems(ctxOf({ status: 'idle' }), entry, 60000, parsed([
    issue(11, { body: '![图](https://example.com/a.png)' }),
  ]), null, { wake: captureWake(sent), fetchImpl })

  assert.equal(sent.length, 1, '图片失败不许拦掉唤醒')
  const text = sent[0].text
  assert.match(text, /【图片】#11 的 1 张图下载失败：不在 GitHub 图片白名单/)
  assert.doesNotMatch(text, /read_image/, '没有存下任何文件就不能叫模型去读')
  assert.doesNotMatch(text, /images[\\/]acme-repo/, '失败的图不许出现不存在的路径')
  assert.equal(fetchImpl.calls.length, 0, '白名单外连请求都不该发（防 SSRF）')
  await settled(() => entry.lastWake !== undefined && entry.lastWake !== null, '这一轮要算真的唤醒过')
})

test('图片 404 时唤醒照常发出，原因写进文本，状态照常前进', async () => {
  const url = 'https://user-images.githubusercontent.com/1/gone.png'
  const sent = []
  const fetchImpl = fakeFetch(() => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } }))
  const entry = persist(makeEntry({ id: 'acme/repo#404', seen: {} }))
  await __test.pollWithItems(ctxOf({ status: 'idle' }), entry, 60000, parsed([
    issue(12, { body: '![图](' + url + ')' }),
  ]), null, { wake: captureWake(sent), fetchImpl })

  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /【图片】#12 的 1 张图下载失败：HTTP 404/)
  assert.doesNotMatch(sent[0].text, /read_image/)
  await settled(() => (entry.wakeTimes || []).length === 1, '唤醒名额要照常消耗（这一轮确实发出去了）')
  assert.equal(entry.wakeTimes.length, 1)
  assert.equal(String(entry.lastWake).startsWith('failed'), false, '下载失败不等于唤醒失败')
})

test('会话正忙：不下载任何图片（提前 return，别白走一趟网络）', async () => {
  const url = 'https://user-images.githubusercontent.com/1/shot.png'
  const sent = []
  const fetchImpl = fakeFetch(() => pngResponse())
  const entry = persist(makeEntry({ id: 'acme/repo#busy', seen: {} }))
  await __test.pollWithItems(ctxOf({ status: 'running' }), entry, 60000, parsed([
    issue(13, { body: '![截图](' + url + ')' }),
  ]), null, { wake: captureWake(sent), fetchImpl })

  assert.equal(sent.length, 0, '会话忙，这一轮不该唤醒')
  assert.equal(fetchImpl.calls.length, 0, '既然不唤醒，就不该先去下图片')
})

test('github 附件：首跳带 Bearer，302 之后第二跳去掉 Authorization，图仍然存下来', async () => {
  // 这条覆盖真机最容易静默失败的那条路径（S3 收到两个签名会 403 / 空 body）。
  const url = 'https://github.com/user-attachments/assets/7c2e2f3a-1234-4bcd-9ef0-123456789abc'
  writeFileSync(join(STATE_DIR, 'secrets.json'), JSON.stringify({ token: 'ghs_panel_token' }))
  const sent = []
  const fetchImpl = fakeFetch((requested) => {
    if (requested === url) return new Response(null, { status: 302, headers: { location: S3_URL } })
    if (requested === S3_URL) return pngResponse()
    return new Response('unexpected', { status: 500 })
  })
  const entry = persist(makeEntry({ id: 'acme/repo#attachment', seen: {} }))
  await __test.pollWithItems(ctxOf({ status: 'idle' }), entry, 60000, parsed([
    issue(14, { body: '截图：![s](' + url + ')' }),
  ]), null, { wake: captureWake(sent), fetchImpl })

  assert.equal(sent.length, 1)
  assert.equal(fetchImpl.calls.length, 2, '必须跟到第二跳')
  assert.equal(headerOf(fetchImpl.calls[0], 'authorization'), 'Bearer ghs_panel_token')
  assert.equal(headerOf(fetchImpl.calls[1], 'authorization'), undefined, 'S3 那一跳不许带 Authorization')
  const path = join(STATE_DIR, 'images', 'acme-repo', 'issue-14', imageName(url))
  assert.ok(sent[0].text.includes(path), '第二跳存下来的图也要出现在文本里')
  assert.equal(existsSync(path), true)
  // 凭证绝不出现在唤醒文本里（唤醒文本还会过 redact()，但不能靠它兜底）
  assert.ok(!sent[0].text.includes('ghs_panel_token'))
})

// ─────────────────────────────────────────────────────────────────────────────
// PR 轮询（pollPrOnce）
// ─────────────────────────────────────────────────────────────────────────────

const prComment = (id, author, body = 'body ' + id) => ({
  id,
  author,
  body,
  createdAt: '2026-11-13T00:00:0' + (id % 10) + 'Z',
})

function prGraphql(rows) {
  return {
    data: {
      search: {
        nodes: rows.map((row) => ({
          number: row.number,
          title: row.title || 'PR ' + row.number,
          isDraft: false,
          headRefName: row.headRef || 'feature/' + row.number,
          headRepository: { nameWithOwner: row.headRepo || 'fork/r' },
          baseRepository: { nameWithOwner: row.baseRepo || 'o/r' },
          comments: {
            nodes: (row.comments || []).map((comment) => ({
              databaseId: comment.id,
              author: { login: comment.author },
              createdAt: comment.createdAt,
              body: comment.body,
            })),
          },
        })),
      },
    },
  }
}

function prDeps(rows, over = {}) {
  return {
    selfLogin: 'me',
    ghRun: async (file, args) => {
      // 首次同步（seenComments 为空）会走 REST 分页拉全量评论，这里要回数组形状
      const joined = (args || []).join(' ')
      const rest = joined.match(/repos\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/comments/)
      if (rest) {
        const row = rows.find((item) => String(item.number) === String(rest[3]))
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify(((row && row.comments) || []).map((c) => ({
            id: c.id, user: { login: c.author }, body: c.body || '', created_at: c.createdAt || '',
          }))),
        }
      }
      return { code: 0, stderr: '', stdout: JSON.stringify(prGraphql(rows)) }
    },
    ...over,
  }
}

const makePrEntry = (id, extra = {}) => ({
  id,
  repo: 'o/r',
  provider: 'github',
  sessionId: 'session-image',
  kind: 'pr',
  intervalSec: 300,
  seenComments: {},
  enabled: true,
  audit: false,
  adversarialAudit: false,
  auditMode: 'subagent',
  observe: false,
  goal: null,
  wakeTimes: [],
  ...extra,
})

test('PR 新评论里的图存到 pr-<number> 目录，图片行追加在唤醒文本末尾', async () => {
  const url = 'https://user-images.githubusercontent.com/1/pr-shot.png'
  const sent = []
  const fetchImpl = fakeFetch(() => pngResponse())
  const entry = makePrEntry('pr:o/r#session-image', { seenComments: { 7: 10 } })
  __test.writeState({ watchers: { [entry.id]: entry } })
  await __test.pollPrOnce({}, entry, 300_000, null, {
    ...prDeps([{ number: 7, title: 'T7', headRef: 'feat/x', comments: [prComment(11, 'alice', '这里不对\n\n![证据](' + url + ')')] }]),
    wake: captureWake(sent),
    fetchImpl,
  })

  assert.equal(sent.length, 1)
  const text = sent[0].text
  const path = join(STATE_DIR, 'images', 'o-r', 'pr-7', imageName(url))
  assert.ok(text.includes(path), 'PR 也要给绝对路径：' + text)
  assert.match(text, /【图片】#7 评论 有 1 张图已存本地，用 read_image 读取：/)
  // 末尾追加：图片段是文本最后一段（处理建议仍在它前面）
  assert.match(text.trimEnd().split('\n\n').pop(), /^【图片】#7 评论/)
  assert.equal(existsSync(path), true)
})

test('PR 评论里的图下载失败：唤醒照发、水位照常推进、失败原因写清', async () => {
  const url = 'https://user-images.githubusercontent.com/1/pr-gone.png'
  const sent = []
  const fetchImpl = fakeFetch(() => new Response('gone', { status: 410, headers: { 'content-type': 'text/plain' } }))
  const entry = makePrEntry('pr:o/r#image-fail', { seenComments: { 7: 10 } })
  __test.writeState({ watchers: { [entry.id]: entry } })
  await __test.pollPrOnce({}, entry, 300_000, null, {
    ...prDeps([{ number: 7, comments: [prComment(11, 'alice', '![图](' + url + ')')] }]),
    wake: captureWake(sent),
    fetchImpl,
  })

  assert.equal(sent.length, 1, '图片下载失败不许拦住 PR 唤醒')
  assert.match(sent[0].text, /【图片】#7 评论 的 1 张图下载失败：HTTP 410/)
  assert.deepEqual(entry.seenComments, { 7: 11 }, '唤醒成功就该推进水位（与图片无关）')
  assert.ok(!String(entry.lastError || '').includes('410'), '图片失败不该污染守的错误状态')
})

/** 带 agents 的 ctx：pollWithItems 用它判断会话是否空闲。 */
function ctxOf(agent) {
  return {
    tools: { register: () => {} },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => ({ id: 'session-image' }), get: () => agent },
    get: () => null,
    effect: (fn) => fn(),
  }
}
test('issue 评论里的图（只出现在 lastComment.images）也会存盘并进唤醒文本', async () => {
  // 真实场景：正文纯文字，截图补充在评论里；唤醒文本只显示「最后评论: @x 时间」，
  // 所以图片 URL 必须由 parseLastComment 提前提取（lastComment.images），否则永远读不到。
  const url = 'https://github.com/user-attachments/assets/4c5a7c7f-fe2b-4879-bd77-4f01b55e3de6'
  const landed = 'https://github-production-user-asset-6210df.s3.amazonaws.com/9/9/9.png'
  const sent = []
  const fetchImpl = fakeFetch((target) => (target === landed
    ? pngResponse()
    : new Response(null, { status: 302, headers: { location: landed } })))
  const entry = persist(makeEntry({ id: 'acme/repo#comment-image', seen: {} }))
  await __test.pollWithItems(ctxOf({ status: 'idle' }), entry, 60000, parsed([
    issue(21, {
      body: '没有正文图片，只有评论',
      lastComment: { login: 'reporter', at: '2026-11-26T10:00:00Z', images: [url] },
    }),
  ]), null, { wake: captureWake(sent), fetchImpl })

  assert.equal(sent.length, 1)
  const text = sent[0].text
  const path = join(STATE_DIR, 'images', 'acme-repo', 'issue-21', imageName(url))
  assert.ok(text.includes(path), '评论里的图也要给绝对路径：' + path + '\n---\n' + text)
  assert.equal(existsSync(path), true, '评论图必须真的落盘')
  assert.deepEqual(fetchImpl.calls.map((call) => call.url), [url, landed], '先附件入口、再 302 落点')
  // 第二跳（S3 预签名）绝不能带 Authorization：带了就是 403 / 空 body
  assert.equal(headerOf(fetchImpl.calls[1], 'authorization'), undefined)
})
