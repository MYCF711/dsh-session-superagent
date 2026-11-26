// 图片提取 / 白名单 / 下载 / 唤醒文本行的离线单测。
//
// 为什么要测这么细：这一段把远端内容变成**本地文件路径**，再交给模型去 read_image。
// 三个地方错了都不会报错，只会「看不到图」：
//   ① 提取漏了某种写法（引用式 markdown、单引号 HTML）→ 图根本不会出现在唤醒文本里；
//   ② 白名单太宽 → issue 里的链接能把会话引导去打内网（SSRF）；太窄 → 官方附件下不动；
//   ③ 跟随重定向时没去掉 Authorization → GitHub 302 到 S3 后 403，客户看到的只是「没图」。
// 全部离线：fetch 一律注入，不联网、不碰真实状态目录。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { tempDir } from './fixtures/tmpdir.mjs'
import {
  DEFAULT_IMAGE_LIMITS,
  appendImageLines,
  downloadImages,
  extractImageUrls,
  imageDirFor,
  imageNoteLines,
  isAllowedImageUrl,
  repoDirName,
} from '../lib/images.js'
// 合并唤醒的纯函数：验证图片段不会被当成「尾巴」丢掉（它和 appendImageLines 是一对）
import { mergeWakeTexts } from '../lib/watch.js'

// 1x1 PNG：只用来验证「魔数判定 + 落盘」，不参与解码。
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const GIF_BYTES = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.alloc(16),
])
const S3_URL = 'https://github-production-user-asset-6210df.s3.amazonaws.com/1/2/3.png?X-Amz-Signature=abc'

const pngResponse = (bytes = PNG_BYTES, headers = {}) => new Response(bytes, {
  status: 200,
  headers: { 'content-type': 'image/png', ...headers },
})

/** 注入用的 fetch：记录每次调用的 url / init，行为由 handler 决定。 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  impl.calls = calls
  return impl
}

const headerOf = (call, name) => {
  const headers = (call && call.init && call.init.headers) || {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// extractImageUrls
// ─────────────────────────────────────────────────────────────────────────────

test('extractImageUrls：markdown 行内图片（带标题/尖括号/单引号）都认得', () => {
  const text = [
    '看这张：![截图](https://user-images.githubusercontent.com/1/a.png)',
    '第二张 ![图](https://camo.githubusercontent.com/abc/68747470 "标题在这里")',
    '第三张 ![图](<https://private-user-images.githubusercontent.com/1/b.webp?jwt=x> \'单引号标题\')',
  ].join('\n')
  assert.deepEqual(extractImageUrls(text), [
    'https://user-images.githubusercontent.com/1/a.png',
    'https://camo.githubusercontent.com/abc/68747470',
    'https://private-user-images.githubusercontent.com/1/b.webp?jwt=x',
  ])
})

test('extractImageUrls：HTML <img> 的双引号/单引号/裸属性都能取到 src', () => {
  const text = [
    '<img width="600" src="https://user-images.githubusercontent.com/1/a.png" />',
    "<img src='https://user-images.githubusercontent.com/1/b.gif'>",
    '<img alt=x src=https://user-images.githubusercontent.com/1/c.jpg>',
  ].join('\n')
  assert.deepEqual(extractImageUrls(text), [
    'https://user-images.githubusercontent.com/1/a.png',
    'https://user-images.githubusercontent.com/1/b.gif',
    'https://user-images.githubusercontent.com/1/c.jpg',
  ])
})

test('extractImageUrls：引用式图片按引用定义取地址', () => {
  const text = [
    '正文 ![第一张][shot1] 后面 ![第二张][] 还有 ![third]',
    '',
    '[shot1]: https://user-images.githubusercontent.com/1/a.png',
    '[第二张]: https://user-images.githubusercontent.com/1/b.png',
    '[third]: https://user-images.githubusercontent.com/1/c.png "带标题"',
  ].join('\n')
  assert.deepEqual(extractImageUrls(text), [
    'https://user-images.githubusercontent.com/1/a.png',
    'https://user-images.githubusercontent.com/1/b.png',
    'https://user-images.githubusercontent.com/1/c.png',
  ])
})

test('extractImageUrls：去重、按出现顺序（跨 markdown / 引用 / HTML）', () => {
  const text = [
    '<img src="https://user-images.githubusercontent.com/1/b.png">',
    '![a](https://user-images.githubusercontent.com/1/a.png)',
    '再来一次 ![a2](https://user-images.githubusercontent.com/1/b.png)',
    '![r][ref]',
    '[ref]: https://user-images.githubusercontent.com/1/c.png',
  ].join('\n')
  // 顺序 = 真实出现顺序（HTML 在最前），重复的第二次不重复收
  assert.deepEqual(extractImageUrls(text), [
    'https://user-images.githubusercontent.com/1/b.png',
    'https://user-images.githubusercontent.com/1/a.png',
    'https://user-images.githubusercontent.com/1/c.png',
  ])
})

test('extractImageUrls：data: / 非 http(s) / 相对路径 / 普通链接 / 明显不是图片的都要忽略', () => {
  const text = [
    '![内联](data:image/png;base64,iVBORw0KGgo=)',
    '![ftp](ftp://example.com/a.png)',
    '![相对](./img/a.png)',
    '普通链接 [这个不是图片](https://user-images.githubusercontent.com/1/page.png) 不算',
    '![文档](https://github.com/o/r/files/1/spec.pdf)',
    '![脚本](https://user-images.githubusercontent.com/1/x.js)',
    '![svg](https://user-images.githubusercontent.com/1/logo.svg)',
  ].join('\n')
  assert.deepEqual(extractImageUrls(text), [])
  // 空输入不能抛：正文空、评论 body 为 null 都是常态
  assert.deepEqual(extractImageUrls(''), [])
  assert.deepEqual(extractImageUrls(null), [])
  assert.deepEqual(extractImageUrls(undefined), [])
})

test('extractImageUrls：http 图片保留到提取层（由白名单给理由拒绝，不是静默丢弃）', () => {
  assert.deepEqual(
    extractImageUrls('![a](http://user-images.githubusercontent.com/1/a.png)'),
    ['http://user-images.githubusercontent.com/1/a.png'],
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// isAllowedImageUrl
// ─────────────────────────────────────────────────────────────────────────────

test('isAllowedImageUrl：GitHub 图片域全放行', () => {
  const allowed = [
    'https://github.com/user-attachments/assets/7c2e2f3a-1234-4bcd-9ef0-123456789abc',
    'https://private-user-images.githubusercontent.com/1/a.png?jwt=eyJhbGci',
    'https://user-images.githubusercontent.com/1/a.png',
    'https://camo.githubusercontent.com/abcdef/68747470733a2f2f',
    'https://objects.githubusercontent.com/github-production-user-asset/1/a.png',
    S3_URL,
  ]
  for (const url of allowed) assert.equal(isAllowedImageUrl(url), true, '应放行：' + url)
})

test('isAllowedImageUrl：非 GitHub 域 / http / 伪装域一律拒绝（防 SSRF）', () => {
  const denied = [
    'http://user-images.githubusercontent.com/1/a.png', // 只认 https
    'https://example.com/a.png',
    'https://github.com.evil.com/a.png',               // 后缀伪装
    'https://evil-githubusercontent.com/a.png',        // 不是 .githubusercontent.com 子域
    'https://githubusercontent.com/a.png',             // 裸域不算
    'https://s3.amazonaws.com/github-production-user-asset-1/a.png', // 不是那个 bucket 子域
    'https://169.254.169.254/latest/meta-data/',
    'ftp://github.com/a.png',
    'javascript:alert(1)',
    '/relative/a.png',
    '',
    null,
    undefined,
  ]
  for (const url of denied) assert.equal(isAllowedImageUrl(url), false, '应拒绝：' + String(url))
  // 端口也算：非 443 的 https 一律不放行（内网服务常挂在非常规端口）
  assert.equal(isAllowedImageUrl('https://github.com:8443/user-attachments/assets/x'), false)
  assert.equal(isAllowedImageUrl('https://github.com:443/user-attachments/assets/x'), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// downloadImages
// ─────────────────────────────────────────────────────────────────────────────

test('downloadImages：成功时按 url 哈希命名，扩展名与 mediaType 来自字节', async () => {
  const dir = join(tempDir('zhuli-img-'), 'nested', 'issue-7')
  const url = 'https://user-images.githubusercontent.com/1/a.png'
  const fetchImpl = fakeFetch(() => pngResponse())
  const result = await downloadImages({ urls: [url], dir, fetchImpl })

  assert.deepEqual(result.failures, [])
  assert.equal(result.files.length, 1)
  const expectedName = createHash('sha256').update(url).digest('hex').slice(0, 12) + '.png'
  assert.equal(result.files[0].path, join(dir, expectedName), '文件名 = url 的 sha256 前 12 位 + 扩展名')
  assert.equal(result.files[0].url, url)
  assert.equal(result.files[0].bytes, PNG_BYTES.length)
  assert.equal(result.files[0].mediaType, 'image/png')
  assert.equal(existsSync(result.files[0].path), true, '文件要真的落盘（read_image 读的是这个路径）')
  assert.deepEqual(Buffer.from(readFileSync(result.files[0].path)), PNG_BYTES)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(headerOf(fetchImpl.calls[0], 'authorization'), undefined, '公开图片不带 Authorization')
})

test('downloadImages：github 附件首跳带 Bearer，302 跟到 S3 时第二跳必须去掉 Authorization', async () => {
  const dir = tempDir('zhuli-img-redirect-')
  const url = 'https://github.com/user-attachments/assets/7c2e2f3a-1234-4bcd-9ef0-123456789abc'
  const fetchImpl = fakeFetch((requested) => {
    if (requested === url) {
      return new Response(null, { status: 302, headers: { location: S3_URL } })
    }
    if (requested === S3_URL) return pngResponse()
    return new Response('unexpected', { status: 500 })
  })
  const result = await downloadImages({ urls: [url], dir, token: 'ghs_secret_token', fetchImpl })

  assert.deepEqual(result.failures, [])
  assert.equal(result.files.length, 1, '跟随重定向后要下载成功')
  assert.equal(fetchImpl.calls.length, 2, '必须真的跟了第二跳')
  // 首跳：Bearer + octet-stream（GitHub 只有看到这两个才回 302）
  assert.equal(headerOf(fetchImpl.calls[0], 'authorization'), 'Bearer ghs_secret_token')
  assert.equal(headerOf(fetchImpl.calls[0], 'accept'), 'application/octet-stream')
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual', '重定向必须自己跟，否则没法在第二跳去掉凭证')
  // 第二跳：S3 预签名 URL 上再带 Bearer 会 403/空 body —— 这是真机踩过的坑
  assert.equal(headerOf(fetchImpl.calls[1], 'authorization'), undefined, '第二跳不许带 Authorization')
  // 文件名仍然只由原始 url 决定（凭证不参与命名）
  assert.equal(
    result.files[0].path,
    join(dir, createHash('sha256').update(url).digest('hex').slice(0, 12) + '.png'),
  )
})

test('downloadImages：重定向到非白名单地址一律拒绝（不让重定向绕过 SSRF 白名单）', async () => {
  const dir = tempDir('zhuli-img-evil-')
  const url = 'https://github.com/user-attachments/assets/abc'
  const fetchImpl = fakeFetch(() => new Response(null, {
    status: 302,
    headers: { location: 'https://169.254.169.254/latest/meta-data/' },
  }))
  const result = await downloadImages({ urls: [url], dir, token: 't', fetchImpl })
  assert.deepEqual(result.files, [])
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].reason, /白名单/)
  assert.equal(fetchImpl.calls.length, 1, '不该真的去请求内网地址')
})

test('downloadImages：超时（AbortController）只让那一张失败，原因写清超时', async () => {
  const dir = tempDir('zhuli-img-timeout-')
  const slow = 'https://user-images.githubusercontent.com/1/slow.png'
  const fast = 'https://user-images.githubusercontent.com/1/fast.png'
  const fetchImpl = fakeFetch((url, init) => {
    if (url === slow) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
        })
      })
    }
    return pngResponse()
  })
  const result = await downloadImages({ urls: [slow, fast], dir, fetchImpl, timeoutMs: 30 })
  assert.equal(result.files.length, 1, '另一张照常存下来')
  assert.equal(result.files[0].url, fast)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].url, slow)
  assert.match(result.failures[0].reason, /超时/)
})

test('downloadImages：超过 maxBytes 的图片跳过并说明原因', async () => {
  const dir = tempDir('zhuli-img-big-')
  const big = 'https://user-images.githubusercontent.com/1/big.png'
  const fetchImpl = fakeFetch(() => pngResponse(Buffer.concat([PNG_BYTES, Buffer.alloc(64)])))
  const result = await downloadImages({ urls: [big], dir, fetchImpl, maxBytes: 32 })
  assert.deepEqual(result.files, [])
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].reason, /上限/)
  assert.equal(existsSync(join(dir, createHash('sha256').update(big).digest('hex').slice(0, 12) + '.png')), false,
    '超限的图片不许留下半个文件')
})

test('downloadImages：多于 maxCount 的 URL 截断（默认 6 张）', async () => {
  const dir = tempDir('zhuli-img-cap-')
  const urls = Array.from({ length: 5 }, (_, i) => 'https://user-images.githubusercontent.com/1/' + i + '.png')
  const fetchImpl = fakeFetch(() => pngResponse())
  const capped = await downloadImages({ urls, dir, fetchImpl, maxCount: 2 })
  assert.equal(capped.files.length, 2)
  assert.deepEqual(capped.failures, [], '截断不算失败（客户不需要看到「第 3 张没下」）')
  assert.equal(fetchImpl.calls.length, 2, '截断后不许再发请求')

  assert.equal(DEFAULT_IMAGE_LIMITS.maxCount, 6)
  const all = await downloadImages({ urls, dir: join(dir, 'all'), fetchImpl })
  assert.equal(all.files.length, 5)
})

test('downloadImages：单张失败不连累其它，也不抛给调用方', async () => {
  const dir = tempDir('zhuli-img-mixed-')
  const notFound = 'https://user-images.githubusercontent.com/1/gone.png'
  const ok = 'https://user-images.githubusercontent.com/1/ok.png'
  const weird = 'https://user-images.githubusercontent.com/1/boom.png'
  const fetchImpl = fakeFetch((url) => {
    if (url === notFound) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    if (url === weird) throw new Error('ECONNRESET')
    return pngResponse()
  })
  const result = await downloadImages({ urls: [notFound, ok, weird], dir, fetchImpl })
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].url, ok)
  assert.equal(result.failures.length, 2)
  assert.match(result.failures[0].reason, /404/)
  assert.match(result.failures[1].reason, /请求失败|ECONNRESET/)
})

test('downloadImages：content-type 与字节不符 / 字节不是图片时跳过', async () => {
  const dir = tempDir('zhuli-img-mismatch-')
  const liar = 'https://user-images.githubusercontent.com/1/liar.png'
  const html = 'https://user-images.githubusercontent.com/1/page.png'
  const gif = 'https://user-images.githubusercontent.com/1/real.gif'
  const fetchImpl = fakeFetch((url) => {
    if (url === liar) return pngResponse(Buffer.from('<html>not an image</html>'), { 'content-type': 'image/png' })
    if (url === html) return pngResponse(Buffer.from('<!doctype html><html>login</html>'), { 'content-type': 'text/html' })
    return pngResponse(GIF_BYTES, { 'content-type': 'image/gif' })
  })
  const result = await downloadImages({ urls: [liar, html, gif], dir, fetchImpl })
  assert.equal(result.files.length, 1, '只有真图片留下')
  assert.equal(result.files[0].url, gif)
  assert.equal(result.files[0].mediaType, 'image/gif')
  assert.equal(result.files.length + result.failures.length, 3, '每张 URL 都要有结论（成功或带原因）')
  assert.match(result.failures[0].reason, /不是支持的图片/)
  assert.match(result.failures[1].reason, /不是支持的图片/)
})

test('downloadImages：content-type 说 png、字节是 gif 时按不符跳过', async () => {
  const dir = tempDir('zhuli-img-declared-')
  const url = 'https://user-images.githubusercontent.com/1/x.png'
  const fetchImpl = fakeFetch(() => pngResponse(GIF_BYTES, { 'content-type': 'image/png' }))
  const result = await downloadImages({ urls: [url], dir, fetchImpl })
  assert.deepEqual(result.files, [])
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].reason, /类型不符/)
})

test('downloadImages：非白名单 URL 不发请求，只留原因', async () => {
  const dir = tempDir('zhuli-img-denied-')
  const fetchImpl = fakeFetch(() => pngResponse())
  const result = await downloadImages({
    urls: ['https://example.com/a.png', 'http://user-images.githubusercontent.com/1/a.png'],
    dir,
    fetchImpl,
  })
  assert.deepEqual(result.files, [])
  assert.equal(result.failures.length, 2)
  assert.match(result.failures[0].reason, /白名单/)
  assert.match(result.failures[1].reason, /https/)
  assert.equal(fetchImpl.calls.length, 0, 'SSRF 的要点就是：连请求都不该发出去')
})

// ─────────────────────────────────────────────────────────────────────────────
// imageNoteLines
// ─────────────────────────────────────────────────────────────────────────────

test('imageNoteLines：成功时一行给全绝对路径，并点名 read_image', () => {
  const lines = imageNoteLines({
    label: '#12',
    files: [
      { path: 'D:\\state\\images\\acme-repo\\issue-12\\aaaa.png' },
      { path: 'D:\\state\\images\\acme-repo\\issue-12\\bbbb.jpg' },
    ],
    failures: [],
  })
  assert.equal(lines.length, 1, '只占一行（唤醒文本要短）')
  assert.equal(
    lines[0],
    '【图片】#12 有 2 张图已存本地，用 read_image 读取：'
      + '`D:\\state\\images\\acme-repo\\issue-12\\aaaa.png` '
      + '`D:\\state\\images\\acme-repo\\issue-12\\bbbb.jpg`',
  )
  // Windows 绝对路径原样写（不做 URL 编码、不换成正斜杠）
  assert.ok(!lines[0].includes('%5C'))
  assert.ok(!lines[0].includes('/'))
})

test('imageNoteLines：有失败时追加第一张的原因（≤60 字），路径仍然保留', () => {
  const lines = imageNoteLines({
    label: '#9',
    files: [{ path: 'D:\\state\\images\\o-r\\issue-9\\aaaa.png' }],
    failures: [{ url: 'https://x/1', reason: 'HTTP 404' }, { url: 'https://x/2', reason: '超时' }],
  })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /用 read_image 读取：`D:\\state\\images\\o-r\\issue-9\\aaaa\.png`/)
  assert.match(lines[0], /（2 张下载失败：HTTP 404）$/, '只报第一张的原因，条数要真实')

  const longReason = imageNoteLines({
    label: '#9',
    files: [],
    failures: [{ url: 'https://x/1', reason: '原'.repeat(120) }],
  })
  const reason = longReason[0].split('：').pop()
  assert.ok([...reason].length <= 60, '原因截到 60 字以内：' + reason.length)
})

test('imageNoteLines：没图也没失败时不出空行（不许凭空造一段）', () => {
  assert.deepEqual(imageNoteLines({ label: '#1', files: [], failures: [] }), [])
  assert.deepEqual(imageNoteLines({}), [])
  // 只有失败：也要说清楚「为什么没图」，而不是沉默
  const onlyFailures = imageNoteLines({
    label: '#3',
    files: [],
    failures: [{ url: 'https://x/1', reason: '不在 GitHub 图片白名单' }],
  })
  assert.equal(onlyFailures.length, 1)
  assert.match(onlyFailures[0], /#3/)
  assert.match(onlyFailures[0], /下载失败：不在 GitHub 图片白名单$/)
  assert.doesNotMatch(onlyFailures[0], /read_image/, '没存下任何文件就不能叫模型去读')
})

test('imageNoteLines：超过 maxInText 只列前几张并说明还有几张', () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ path: 'D:\\s\\img-' + i + '.png' }))
  const lines = imageNoteLines({ label: '#5', files, failures: [], maxInText: 2 })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /有 4 张图已存本地/)
  assert.ok(lines[0].includes('img-0.png') && lines[0].includes('img-1.png'))
  assert.ok(!lines[0].includes('img-2.png'), '超出的不列路径，避免一行爆炸')
  assert.match(lines[0], /另有 2 张/)
})
// ─────────────────────────────────────────────────────────────────────────────
// appendImageLines（并进唤醒文本的位置）
// ─────────────────────────────────────────────────────────────────────────────

test('appendImageLines：插在「接下来：」之前，收尾指令仍在最后', () => {
  const text = '【主理鱼】o/r 有 1 条新动态：\n#7 [open] 修登录 —— @alice (issue) https://x/7\n\n接下来：先读仓库 AGENTS.md。'
  const out = appendImageLines(text, ['【图片】#7 有 1 张图已存本地，用 read_image 读取：D:\\state\\a.png'])
  const lines = out.split('\n')
  assert.equal(lines[lines.length - 1], '接下来：先读仓库 AGENTS.md。', '收尾指令必须还在最后一行')
  assert.ok(out.indexOf('【图片】') >= 0)
  assert.ok(out.indexOf('【图片】') < out.indexOf('接下来：'), '图片段要在收尾指令之前：' + out)

  // PR 文本没有「接下来：」这一段 → 追加到末尾
  const pr = appendImageLines('【PR 响应】o/r#7 有 1 条新评论\n\n处理建议: 阅读评论 → 回评', ['【图片】#7 评论 有 1 张图已存本地'])
  assert.ok(pr.endsWith('【图片】#7 评论 有 1 张图已存本地'))
  // 没有图片段：原样返回（一个字符都不动，避免污染既有唤醒文本的快照）
  assert.equal(appendImageLines(text, []), text)
  assert.equal(appendImageLines('', ['【图片】#1 有 1 张图']), '【图片】#1 有 1 张图')

  // 引文里的「接下来：」不算收尾指令：PR 评论正文是引用块（`> 接下来：…`），
  // 按 indexOf 找会把图片段插进别人的引文正中间。
  const quoted = '【PR 响应】o/r#7 有 1 条新评论\n\n评论者: alice（非本人）\n时间: x\n\n> 接下来：修这里\n\n处理建议: 阅读评论 → 回评'
  const withQuote = appendImageLines(quoted, ['【图片】#7 评论 有 1 张图'])
  assert.ok(withQuote.endsWith('【图片】#7 评论 有 1 张图'), '引文里出现「接下来：」也要追加到末尾：' + withQuote)
})

test('appendImageLines：两条唤醒合并后两条图片路径都还在（合并只留一条尾巴）', () => {
  const one = '【主理鱼】o/r 有 1 条新动态：\n#1 [open] a\n\n接下来：读 AGENTS.md'
  const two = '【主理鱼】o/r 有 1 条新动态：\n#2 [open] b\n\n接下来：读 AGENTS.md'
  const merged = mergeWakeTexts([
    appendImageLines(one, ['【图片】#1 有 1 张图已存本地，用 read_image 读取：D:\\state\\one.png']),
    appendImageLines(two, ['【图片】#2 有 1 张图已存本地，用 read_image 读取：D:\\state\\two.png']),
  ])
  assert.ok(merged.includes('D:\\state\\one.png'), '第一条唤醒的图片路径不能丢：' + merged)
  assert.ok(merged.includes('D:\\state\\two.png'), '第二条也不许被当成尾巴丢掉：' + merged)
  assert.equal((merged.match(/接下来：/g) || []).length, 1, '收尾指令仍然只留一份')
})

test('repoDirName / imageDirFor：首尾点号与非法编号不许把图片目录带出 images/', () => {
  assert.equal(repoDirName('..'), 'repo', '.. 会被 Windows/Linux 当成上级目录')
  assert.equal(repoDirName('...'), 'repo')
  assert.equal(repoDirName('acme/repo'), 'acme-repo')
  assert.equal(repoDirName('gitee:acme/repo'), 'acme-repo')
  assert.equal(repoDirName(''), 'repo')
  assert.equal(imageDirFor(join('C:', 'state'), '..', 'issue', '7'), join('C:', 'state', 'images', 'repo', 'issue-7'))
  assert.equal(imageDirFor('/state', 'acme/repo', 'pr', '12'), join('/state', 'images', 'acme-repo', 'pr-12'))
  assert.equal(imageDirFor('/state', 'acme/repo', 'issue', '../x'), join('/state', 'images', 'acme-repo', 'issue-unknown'),
    '编号只允许纯数字：路径片段不能从 number 混进来')
  assert.equal(imageDirFor('/state', 'acme/repo', 'other', '3'), join('/state', 'images', 'acme-repo', 'issue-3'),
    '未知 kind 一律按 issue 落盘，避免出现 issue-3 之外的目录')
})

test('downloadImages：同一 URL 第二次直接复用已下载文件，不再发请求', async () => {
  const url = 'https://user-images.githubusercontent.com/1/reuse.png'
  const dir = join(tempDir('zhuli-img-reuse-'), 'issue-1')
  let calls = 0
  const first = await downloadImages({ urls: [url], dir, fetchImpl: async () => {
    calls += 1
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
  } })
  assert.equal(first.files.length, 1)
  assert.equal(calls, 1)
  const second = await downloadImages({ urls: [url], dir, fetchImpl: async () => {
    calls += 1
    throw new Error('不该再发请求')
  } })
  assert.equal(calls, 1, '第二次必须命中本地文件，不再走网络')
  assert.equal(second.files.length, 1)
  assert.equal(second.files[0].path, first.files[0].path, '路径必须稳定（模型/日志能对上）')
  assert.equal(existsSync(first.files[0].path), true)
})

test('mergeWakeTexts：正文（引用块 / 标题）里出现「接下来：」不许截掉后面的图片路径', () => {
  // 审计复现 A：两条 PR 唤醒，第一条评论引用了「> 接下来：」—— 旧实现按 indexOf 截断，
  // 合并后 one.png 还在、two.png 静默消失。
  const one = '【PR 响应】acme/repo#1 有 2 条新评论\n\n@a 时间: 看这里\n> 接下来：这句是引文，不是收尾\n\n'
    + '【图片】#1 有 1 张图已存本地，用 read_image 读取：' + String.fromCharCode(96) + 'D:\\img\\one.png' + String.fromCharCode(96)
  const two = '【PR 响应】acme/repo#2 有 1 条新评论\n\n@b 时间: 第二处\n\n'
    + '【图片】#2 有 1 张图已存本地，用 read_image 读取：' + String.fromCharCode(96) + 'D:\\img\\two.png' + String.fromCharCode(96)
  const merged = mergeWakeTexts([one, two])
  assert.ok(merged.includes('one.png'), '引文里的「接下来：」不能被当成收尾')
  assert.ok(merged.includes('two.png'), '两条路径都要在（合并只留一条尾巴，但不是把图片丢掉）')

  // 审计复现 B：issue 标题含「接下来：」（陌生人可控）—— 旧实现会从标题中间截断。
  const a = '#9 [open] 汇总 接下来：先看图 — @a\n\n'
    + '【图片】#9 有 1 张图已存本地，用 read_image 读取：' + String.fromCharCode(96) + 'D:\\img\\nine.png' + String.fromCharCode(96)
  const b = '#10 [open] b — @a\n\n'
    + '【图片】#10 有 1 张图已存本地，用 read_image 读取：' + String.fromCharCode(96) + 'D:\\img\\ten.png' + String.fromCharCode(96)
    + '\n\n接下来：先读仓库 AGENTS.md'
  const merged2 = mergeWakeTexts([a, b])
  assert.ok(merged2.includes('nine.png'), '标题里的「接下来：」只算正文，不能截断整条')
  assert.ok(merged2.includes('ten.png'))
  assert.equal(merged2.split('接下来：先读仓库').length - 1, 1, '真正的收尾块只保留一次')
})
