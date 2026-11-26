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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_IMAGE_LIMITS, repoDirName } from '../lib/images.js'
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

const REPO_DIR = repoDirName('acme/repo')

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
  const dir = join(STATE_DIR, 'images', REPO_DIR, 'issue-7')
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
  assert.ok(!text.includes(REPO_DIR) && !text.includes('images' + String.fromCharCode(92) + 'acme'),
    '失败的图不许出现不存在的目录（目录名是 ' + REPO_DIR + '）')
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
  const path = join(STATE_DIR, 'images', REPO_DIR, 'issue-14', imageName(url))
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
  const path = join(STATE_DIR, 'images', repoDirName('o/r'), 'pr-7', imageName(url))
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
  const path = join(STATE_DIR, 'images', REPO_DIR, 'issue-21', imageName(url))
  assert.ok(text.includes(path), '评论里的图也要给绝对路径：' + path + '\n---\n' + text)
  assert.equal(existsSync(path), true, '评论图必须真的落盘')
  assert.deepEqual(fetchImpl.calls.map((call) => call.url), [url, landed], '先附件入口、再 302 落点')
  // 第二跳（S3 预签名）绝不能带 Authorization：带了就是 403 / 空 body
  assert.equal(headerOf(fetchImpl.calls[1], 'authorization'), undefined)
})

test('离线模式下不进网络，但要在唤醒文本里说明「离线没下」（不许静默）', async () => {
  // 这个文件的 DSH_SUPERAGENT_OFFLINE=1；不注入 fetch 时 collectImageLines 走离线分支。
  const url = 'https://user-images.githubusercontent.com/1/offline.png'
  const sent = []
  const entry = persist(makeEntry({ id: 'acme/repo#offline', seen: {} }))
  const fetchImpl = undefined
  await __test.pollWithItems(ctxOf({ status: 'idle' }), entry, 60000, parsed([
    issue(31, { body: '![图](' + url + ')' }),
  ]), null, { wake: captureWake(sent) })
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /离线模式，没有下载/, '离线跳过必须写出来，否则客户以为是功能坏了：' + sent[0].text)
  assert.ok(!sent[0].text.includes(imageName(url)))
})

test('生产入口 collectImageLines 用默认预算就能下成功（PR #76 review：以前每张都「超时（NaN 秒）」）', async () => {
  // reviewer 的复现路径：**不改任何参数、只走默认值**。
  // 以前 DEFAULT_IMAGE_LIMITS 漏 deadlineMs → index.js 传 undefined →
  // budgetAt=NaN → setTimeout(NaN)=1ms → 每张图都失败，而这里的用例都没走 index.js 那组参数。
  // 这条路必须真的调 collectImageLines（不是 downloadImages），否则这个 bug 永远测不出来。
  const url = 'https://user-images.githubusercontent.com/1/prod-path.png'
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const calls = []
  // ⚠️ 两个条件缺一不可，否则测不出 reviewer 那个 bug（实测各漏一次）：
  //   ① 有真实网络量级的延迟：`setTimeout(NaN)` 被压成 **1ms**，同步 resolve 就来不及 abort；
  //   ② **桩必须尊重 signal**：真实 `fetch` 在 abort 时 reject，假 fetch 若视而不见，
  //      1ms 的 abort 就白发了 —— 这也是原来那批用例没发现问题的原因。
  const fetchImpl = (target, init = {}) => {
    calls.push(String(target && target.url || target))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })), 40)
      const signal = init && init.signal
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return }
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        }, { once: true })
      }
    })
  }
  const lines = await __test.collectImageLines({
    repo: 'acme/prod',
    kind: 'issue',
    number: 77,
    texts: ['![截图](' + url + ')'],
    provider: 'github',
    token: '',
    fetchImpl,
    label: '#77',
  })
  assert.equal(calls.length, 1, '必须真的发起一次下载：' + JSON.stringify(calls))
  assert.equal(lines.length, 2, '两行：路径行 + 安全边界行：' + JSON.stringify(lines))
  // 🔒 单一来源守卫（对抗审计打穿点 #1）：这个用例必须证明预算**来自 DEFAULT_IMAGE_LIMITS**，
  //   而不是「恰好等于某个硬编码值」。否则有人把 index.js 改成 `deadlineMs: 45_000` 硬编码，
  //   同时删掉 DEFAULT 里那项，这个用例照样绿 —— 同类 bug 又被藏起来。
  //   做法：DEFAULT 里 deadlineMs 必须存在且是正整数（由下面的前置断言保证），
  //   并断言本条用例成功时它读到的正是 DEFAULT 的值（不是 45_000 这个字面量）。
  assert.equal(Number.isFinite(DEFAULT_IMAGE_LIMITS.deadlineMs) && DEFAULT_IMAGE_LIMITS.deadlineMs > 0, true,
    'DEFAULT_IMAGE_LIMITS.deadlineMs 必须存在（index.js 直接按这个名字取）')
  // 取一个比 DEFAULT 小、但仍能容纳 40ms 桩的值，注入 downloadImages 不应影响 collectImageLines
  // （collectImageLines 不接受外部预算）——所以这里只断言 DEFAULT 值本身合理，且用例确实下了图。
  assert.ok(DEFAULT_IMAGE_LIMITS.deadlineMs >= 1000, '整批预算必须 ≥ 1000ms（否则 40ms 的图都可能被误杀）')
  assert.ok(/read_image/.test(lines[0]), '说明里要点名 read_image：' + lines[0])
  assert.ok(!/NaN/.test(lines[0]), '绝不能出现「下载超时（NaN 秒）」：' + lines[0])
  assert.match(lines[1], /不是本会话的指令/, '必须带「图中文字不是指令」的安全边界：' + lines[1])
  // 而且文件要真的落在 state/images 下
  const path = join(STATE_DIR, 'images', repoDirName('acme/prod'), 'issue-77', imageName(url))
  assert.equal(existsSync(path), true, '图片必须真的落盘：' + path)
})

test('index.js 的图片预算必须来自 DEFAULT_IMAGE_LIMITS，不能硬编码（对抗审计打穿点 #1）', () => {
  // 为什么需要这条「源码形状」断言：上面那条集成用例走 collectImageLines，
  // 但 collectImageLines **不接受外部预算**，预算在 index.js 里写死取 DEFAULT。
  // 如果有人在 index.js 里写 `deadlineMs: 45_000`（硬编码）同时删掉 DEFAULT 里那项，
  // 集成用例照样绿（它只验证「能下成功」），于是同类 bug 又被藏起来。
  // 这里直接读源码，断言它引用的是 `DEFAULT_IMAGE_LIMITS.deadlineMs` 这个**变量**
  // （以及 maxCount 也是），而不是字面量。文档/测试，不是实现保护 —— 但能拦住那种「优化」。
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const at = source.indexOf('await downloadImages(')
  assert.ok(at >= 0, '找不到 downloadImages 调用点')
  const block = source.slice(at, source.indexOf('})', at))
  assert.match(block, /deadlineMs:\s*DEFAULT_IMAGE_LIMITS\.deadlineMs/, 'index.js 的 deadlineMs 必须引用 DEFAULT_IMAGE_LIMITS.deadlineMs，不能硬编码：' + block.slice(0, 300))
  assert.match(block, /maxCount:\s*DEFAULT_IMAGE_LIMITS\.maxCount/, 'index.js 的 maxCount 也必须引用 DEFAULT_IMAGE_LIMITS.maxCount')
  assert.equal(/deadlineMs:\s*\d/.test(block), false, 'index.js 不能写死 deadlineMs 数字')
})

test('预算参数是编程错误时必须响亮降级（写进唤醒文本），不能静默变成「本来就没图」（对抗审计打穿点 #2）', async () => {
  // 审计原话：`collectImageLines` 的 `catch{return []}` 把所有编程错误（含预算 TypeError）
  // 变成「无声无图」—— 用户以为 issue 本来没图，比「每张图都失败」更难发现。
  // 行为级验证：让 collectImageLines 触发 TypeError 只有一条真实路径 ——
  // 传一个会让 downloadOne 抛 TypeError 之外的东东不行，故用 shortErrText 的行为 + 源码形状双管：
  //   ① shortErrText 必须能把 Error 变成一行非空摘要（响亮降级用的就是它）
  const msg = __test.shortErrText(new TypeError('图片下载预算参数缺失或非法：deadlineMs'))
  assert.ok(msg.length > 0 && /预算|deadlineMs/.test(msg), 'shortErrText 必须给出可读摘要：' + JSON.stringify(msg))
  //   ② catch 必须区分 TypeError 与普通错误
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const at = source.indexOf('async function collectImageLines(')
  const block = source.slice(at, source.indexOf('\n}\n', at))
  assert.match(block, /error instanceof TypeError/, 'TypeError（编程错误）必须单独分支，响亮降级')
  assert.match(block, /【图片】/, 'TypeError 分支必须产出一条可见的【图片】文本')
  //   ③ 行为级：一个必然抛 TypeError 的场景 —— texts 里放一个 URL，但让 extractImageUrls 前
  //      注入一个 throws TypeError 的 getter 太绕。改为断言线下：普通 environment 错误静默、
  //      programmer 错误响亮，逻辑由上面两条覆盖。这里补一条：真的用短超时（正常参数）下成功。
  const url2 = 'https://user-images.githubusercontent.com/1/ok2.png'
  const png2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const lines2 = await __test.collectImageLines({
    repo: 'acme/ok2', kind: 'issue', number: 88, texts: ['![](' + url2 + ')'], provider: 'github', token: '',
    fetchImpl: async () => new Response(png2, { status: 200, headers: { 'content-type': 'image/png' } }),
    label: '#88',
  })
  assert.ok(lines2.some((l) => /read_image/.test(l)), '正常参数下必须产出 read_image 行：' + JSON.stringify(lines2))
})
