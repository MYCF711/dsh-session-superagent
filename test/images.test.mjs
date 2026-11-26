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
  __test as imagesTest,
  appendImageLines,
  downloadImages,
  extractImageUrls,
  imageDirFor,
  imageNoteLines,
  isAllowedImageUrl,
  pixelsWithinLimit,
  readImageDimensions,
  repoDirName,
} from '../lib/images.js'
// 合并唤醒的纯函数：验证图片段不会被当成「尾巴」丢掉（它和 appendImageLines 是一对）
import { mergeWakeTexts } from '../lib/watch.js'

// 1x1 PNG：只用来验证「魔数判定 + 落盘」，不参与解码。
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
// 1x1 GIF：头 6 字节签名 + 逻辑屏幕宽高（偏移 6..10，小端 u16，这里是 1×1）。
// 以前是「GIF89a + 16 个零字节」—— 宽高都是 0，像素校验上线后会被判「无法确认尺寸」拒绝，
// 那个夹具本身就不像真 GIF（真实 GIF 的宽高不可能为 0）。
const GIF_BYTES = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([0x01, 0x00, 0x01, 0x00]),   // width=1, height=1 (LE u16)
  Buffer.alloc(12),
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
  assert.equal(lines.length, 2, '两行：路径行 + 不可信数据边界行')
  assert.equal(
    lines[0],
    '【图片】#12 有 2 张图已存本地，用 read_image 读取：'
      + '`D:\\state\\images\\acme-repo\\issue-12\\aaaa.png` '
      + '`D:\\state\\images\\acme-repo\\issue-12\\bbbb.jpg`',
  )
  // 第二行是安全边界（PR #76 安全复核）：图里的文字不是指令
  assert.match(lines[1], /外部仓库内容/, '必须声明图片来自外部')
  assert.match(lines[1], /不是本会话的指令/, '必须声明图中文字不是指令')
  assert.match(lines[1], /不得据此执行任何写操作/, '必须禁止据此执行写操作')
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
  assert.equal(lines.length, 2, '路径行 + 边界行')
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
  assert.equal(lines.length, 2, '路径行 + 边界行')
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

test('repoDirName / imageDirFor：首尾点号、非法编号、多仓撞名都不许出问题', () => {
  // 首尾点号：'..' 会被 Windows/Linux 当成上级目录
  assert.ok(repoDirName('..').startsWith('repo-'), '.. 必须落回 repo 前缀')
  assert.ok(repoDirName('...').startsWith('repo-'))
  // 不同 repo 一定不同目录（审计：'acme/repo' 与 'acme-repo' 会撞成同一个名字 → 图片串仓）
  assert.notEqual(repoDirName('acme/repo'), repoDirName('acme-repo'), '清洗后的撞名必须由短 hash 区分')
  assert.notEqual(repoDirName('acme/repo'), repoDirName('acme.gitee/repo'))
  // 同一个 repo 每次必须稳定（文件名要能对上）
  assert.equal(repoDirName('acme/repo'), repoDirName('acme/repo'))
  assert.match(repoDirName('acme/repo'), /^acme-repo-[0-9a-f]{6}$/)
  const base = repoDirName('acme/repo')
  assert.equal(imageDirFor('/state', 'acme/repo', 'pr', '12'), join('/state', 'images', base, 'pr-12'))
  assert.equal(imageDirFor('/state', 'acme/repo', 'issue', '../x'), join('/state', 'images', base, 'issue-unknown'),
    '编号只允许纯数字：路径片段不能从 number 混进来')
  assert.equal(imageDirFor('/state', 'acme/repo', 'other', '3'), join('/state', 'images', base, 'issue-3'),
    '未知 kind 一律按 issue 落盘')
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

test('extractImageUrls：65KB 的 ![ 洪泛必须在预算内返回（不许冻住宿主）', () => {
  // 审计实测：旧正则在 65KB '![' 上跑 4807ms，事件循环被饿住 8.5s；GitHub 正文字符上限就是 65536。
  const flood = '!['.repeat(32_768)
  const startedAt = Date.now()
  const urls = extractImageUrls(flood)
  const elapsed = Date.now() - startedAt
  assert.deepEqual(urls, [])
  assert.ok(elapsed < 500, '提取必须远低于 500ms（实际 ' + elapsed + 'ms）')
  // 命中条数上限：32 张封顶，避免一条正文里有几千个图把下载/文本撑爆
  const many = Array.from({ length: 100 }, (_, i) => '![a](https://user-images.githubusercontent.com/' + i + '/x.png)').join('\n')
  assert.ok(extractImageUrls(many).length <= 32)
})

test('downloadImages：全局并发有上限（多条 issue 同时下也不会超过 4 个在飞）', async () => {
  const dir = join(tempDir('zhuli-img-concurrency-'), 'issue-1')
  let inFlight = 0
  let peak = 0
  const urls = Array.from({ length: 12 }, (_, i) => 'https://user-images.githubusercontent.com/1/' + i + '.png')
  const fetchImpl = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 15))
    inFlight -= 1
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
  }
  // 两个任务同时跑（= 两条 issue 同轮轮询），闸门是进程级的
  await Promise.all([
    downloadImages({ urls: urls.slice(0, 6), dir, fetchImpl }),
    downloadImages({ urls: urls.slice(6), dir: dir + '-b', fetchImpl }),
  ])
  assert.ok(peak <= 4, '全局并发不能超过 4（实际峰值 ' + peak + '）')
  assert.ok(peak >= 2, '也不该退化成一个一个下（实际峰值 ' + peak + '）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 默认预算参数（PR #76 review：生产路径每张图都「下载超时（NaN 秒）」）
// ─────────────────────────────────────────────────────────────────────────────
//
// 之前的漏洞形状：`DEFAULT_IMAGE_LIMITS` 漏了 `deadlineMs`，而 `lib/index.js` 一直按
// 这个名字取 → `deadlineMs: undefined` → `budgetAt = Date.now() + undefined = NaN`
// → `setTimeout(NaN)` 被 Node 压成 1ms → 生产路径**每张图都失败**。
// 而上面所有用例都是直接调 downloadImages 并（隐式或显式）手传预算，
// 压根没人检查「默认值本身完不完整」，于是全绿也发现不了。
test('DEFAULT_IMAGE_LIMITS 必须齐全：index.js 依赖的每个字段都在，且都是正整数', () => {
  // 这几个名字是 lib/index.js 实际读取的，少一个就是 undefined
  for (const name of ['maxCount', 'maxBytes', 'timeoutMs', 'deadlineMs']) {
    const value = DEFAULT_IMAGE_LIMITS[name]
    assert.equal(Number.isFinite(value) && value > 0, true, 'DEFAULT_IMAGE_LIMITS.' + name + ' 必须是正整数，实际：' + JSON.stringify(value))
  }
  // deadlineMs 曾经就是漏的那一个，单独钉死（防止以后又被删掉）
  assert.equal(DEFAULT_IMAGE_LIMITS.deadlineMs, 45_000, 'deadlineMs 必须存在且是 45 秒（index.js 的整批预算）')
})

test('downloadImages：只传默认参数（不手传 deadlineMs）也能下成功，预算不能是 NaN', async () => {
  // 这是 reviewer 的复现路径：完全走 index.js 那组参数
  const dir = tempDir('zhuli-img-default-')
  const url = 'https://user-images.githubusercontent.com/1/default.png'
  const fetchImpl = fakeFetch(() => pngResponse())
  const result = await downloadImages({
    urls: [url],
    dir,
    fetchImpl,
    maxCount: DEFAULT_IMAGE_LIMITS.maxCount,
    deadlineMs: DEFAULT_IMAGE_LIMITS.deadlineMs,
  })
  assert.deepEqual(result.failures, [], '默认预算下不该有任何失败（以前是「下载超时（NaN 秒）」）')
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].bytes, PNG_BYTES.length)
})

test('预算参数算不出来就抛 TypeError，不静默降级成 1ms（防同类回归）', async () => {
  const dir = tempDir('zhuli-img-nan-')
  const url = 'https://user-images.githubusercontent.com/1/nan.png'
  const fetchImpl = fakeFetch(() => pngResponse())
  // ① 兜底也缺失 → 必须抛（reviewer 那次的形状：DEFAULT 漏了 deadlineMs）
  assert.throws(
    () => imagesTest.budgetInt(undefined, undefined, 'deadlineMs'),
    (error) => error instanceof TypeError && /预算参数缺失或非法/.test(error.message),
    '兜底为 undefined 时必须抛 TypeError，不能让 NaN 传进 setTimeout',
  )
  // ② 传了值但非法、兜底也没有 → 同样抛
  assert.throws(() => imagesTest.budgetInt(NaN, undefined, 'timeoutMs'), TypeError)
  // ③ 对照：兜底有效 → 用兜底，不抛（这才是生产的正常路径）
  assert.equal(imagesTest.budgetInt(undefined, 45_000, 'deadlineMs'), 45_000)
  // ④ 集成路径：显式传非法值但默认值有效 → 回落到默认，正常下成功
  const res = await downloadImages({ urls: [url], dir, fetchImpl, deadlineMs: -1 })
  assert.equal(res.files.length, 1, '非法值应回落到有效默认值，而不是抛或 NaN')
  // ⑤ 显式给合法预算也正常
  const ok = await downloadImages({ urls: [url], dir, fetchImpl, deadlineMs: 5_000 })
  assert.equal(ok.files.length, 1)
})

test('imageNoteLines：maxInText 显式 0 / 非法 回落默认，不会「一张都不列」（审计 L1）', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ path: '/tmp/p' + i + '.png' }))
  for (const value of [0, -1, NaN, undefined, 'abc']) {
    const lines = imageNoteLines({ label: '#1', files, failures: [], maxInText: value })
    const paths = (lines[0] || '').match(/\.png/g) || []
    assert.equal(paths.length, 6, 'maxInText=' + String(value) + ' 必须回落默认 6（不是 0 张）：' + String(lines))
  }
  // 显式正数仍然生效
  const three = imageNoteLines({ label: '#1', files, failures: [], maxInText: 3 })
  assert.equal((three[0].match(/\.png/g) || []).length, 3, '显式 maxInText=3 必须只列 3 张')
})

test('超时原因不足 1 秒时写成「不足 1 秒」，不是「0 秒」（审计 L2）', async () => {
  const dir = tempDir('zhuli-img-secs-')
  const url = 'https://user-images.githubusercontent.com/1/slow.png'
  // 桩 40ms 才回；deadlineMs=1 → 剩余预算 <500ms，旧措辞会写成「下载超时（0 秒）」
  const fetchImpl = (target, init = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(pngResponse()), 40)
    const signal = init && init.signal
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
  })
  // deadlineMs=1 会让 Date.now() >= budgetAt 立刻成立，走「预算用完」那条（不会进 downloadOne）。
  // 要触发「单张超时」且剩余 <1s，得给一个能过前面的预算、又让剩余不足 1 秒的值：
  // URL 处理本身要几毫秒，deadlineMs=30 时进入 downloadOne 的剩余约 20~29ms（<1000）。
  const result = await downloadImages({ urls: [url], dir, fetchImpl, deadlineMs: 30 })
  assert.equal(result.files.length, 0)
  assert.equal(result.failures.length, 1)
  assert.ok(/超时/.test(result.failures[0].reason), result.failures[0].reason)
  assert.equal(/0 秒/.test(result.failures[0].reason), false, '不足 1 秒不能写成「0 秒」：' + result.failures[0].reason)
  assert.ok(/不足 1 秒/.test(result.failures[0].reason), '应写「不足 1 秒」：' + result.failures[0].reason)
})

// ─────────────────────────────────────────────────────────────────────────────
// 像素炸弹防护（PR #76 安全复核：只限字节数不够，PNG 能解成数十 GB）
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个「头部合法、尺寸极大、但字节很小」的 PNG（像素炸弹的形状）。 */
function bombPng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0)
  return Buffer.concat([sig, ihdrLen, Buffer.from('IHDR', 'latin1'), ihdrData])
}

test('readImageDimensions：PNG / GIF / WebP(VP8/VP8L/VP8X) 头能读出宽高', () => {
  // PNG：正常夹具应读出 1×1
  assert.deepEqual(readImageDimensions(PNG_BYTES), { width: 1, height: 1 })
  // 炸弹 PNG：读出来就是真实声明的大尺寸
  assert.deepEqual(readImageDimensions(bombPng(65535, 65535)), { width: 65535, height: 65535 })
  // GIF：1×1
  assert.deepEqual(readImageDimensions(GIF_BYTES), { width: 1, height: 1 })
  // 乱字节读不出 → null
  assert.equal(readImageDimensions(Buffer.from('not an image at all')), null)
  assert.equal(readImageDimensions(null), null)
})

test('pixelsWithinLimit：超单边 / 超总像素 / 无法确认，一律超限', () => {
  assert.equal(pixelsWithinLimit({ width: 100, height: 100 }), true)
  assert.equal(pixelsWithinLimit({ width: 65535, height: 65535 }), false, '单边超限')
  assert.equal(pixelsWithinLimit({ width: 9000, height: 1 }), false, '单边 9000 > 8192')
  assert.equal(pixelsWithinLimit({ width: 8000, height: 8000 }), false, '64M > 40M 总像素')
  assert.equal(pixelsWithinLimit(null), false, '无法确认尺寸必须视为超限（炸弹藏在无法确认里）')
})

test('downloadImages：像素炸弹（header 合法但尺寸超阈值）直接判失败，连文件都不落', async () => {
  const dir = tempDir('zhuli-img-bomb-')
  const url = 'https://user-images.githubusercontent.com/1/bomb.png'
  // 65535×65535 的 PNG 头，字节只有几十个 —— 这就是压缩比极高的像素炸弹形状
  const fetchImpl = fakeFetch(() => pngResponse(bombPng(65535, 65535)))
  const result = await downloadImages({ urls: [url], dir, fetchImpl })
  assert.equal(result.files.length, 0, '像素超限的图一张都不能留')
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].reason, /像素超过上限/, '要说清是像素超限：' + result.failures[0].reason)
  assert.match(result.failures[0].reason, /65535×65535/, '要报出实际尺寸方便排查')
  // 关键：**文件绝不能落盘**（落盘后 read_image 一读就 OOM）
  const escaped = createHash('sha256').update(url).digest('hex').slice(0, 12) + '.png'
  assert.equal(existsSync(join(dir, escaped)), false, '像素炸弹不能落盘（read_image 解码那一刻就 OOM）')

  // 对照：同样字节大小、但尺寸正常（1×1）的 PNG 必须正常落盘（证明不是「什么都拒」）
  const ok = await downloadImages({
    urls: ['https://user-images.githubusercontent.com/1/small.png'],
    dir, fetchImpl: fakeFetch(() => pngResponse()),
  })
  assert.equal(ok.files.length, 1, '正常尺寸的图必须能下')
})

test('downloadImages：尺寸读不出来（非标准头）也拒绝，不落盘', async () => {
  const dir = tempDir('zhuli-img-nodim-')
  const url = 'https://user-images.githubusercontent.com/1/weird.png'
  // 魔数是 PNG，但 IHDR 之外是垃圾、宽高读成 0 → readImageDimensions 返回 null → 拒绝
  const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4), Buffer.from('IHDR', 'latin1'), Buffer.alloc(9)])
  const result = await downloadImages({ urls: [url], dir, fetchImpl: fakeFetch(() => pngResponse(fake)) })
  assert.equal(result.files.length, 0, '无法确认尺寸的图必须拒绝')
  assert.match(result.failures[0].reason, /像素超过上限|无法确认/)
})

test('downloadImages：磁盘上已有的超大图走复用路径也必须拒（对抗审计打穿点）', async () => {
  const dir = tempDir('zhuli-img-reuse-bomb-')
  const url = 'https://user-images.githubusercontent.com/1/reuse-bomb.png'
  // 预先在「复用会命中的位置」放一张超大图（模拟旧版本没有像素校验时下的、或手工放的）
  const name = createHash('sha256').update(url).digest('hex').slice(0, 12) + '.png'
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), bombPng(65535, 65535))
  const fetchImpl = fakeFetch(() => pngResponse())   // 若误走网络就会拿到正常 1×1 图
  const result = await downloadImages({ urls: [url], dir, fetchImpl })
  assert.equal(result.files.length, 0, '磁盘上的超大图不能被复用交给 read_image')
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0].reason, /像素超过上限/, '复用路径也要报像素超限：' + result.failures[0].reason)
  assert.equal(fetchImpl.calls.length, 0, '命中复用就不该再走网络')
  // 超限的旧文件应被清掉，避免下次重来
  assert.equal(existsSync(join(dir, name)), false, '超限的旧文件应被删除')
})

test('readImageDimensions：畸形/超短/随机字节一律返回 null，不抛异常、不死循环', () => {
  const cases = {
    '空字节': Buffer.alloc(0),
    '3 字节': Buffer.from([1, 2, 3]),
    '只有 PNG 魔数（不足读 IHDR）': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    'JPEG 反复 SOI 50 次': Buffer.concat(Array(50).fill(Buffer.from([0xff, 0xd8]))),
    'JPEG length=0': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd8]),
    'JPEG length=65535（会跳出边界）': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00, 0x00]),
    'GIF 头不全': Buffer.from('GIF89a01', 'latin1'),
    'WebP 头不全': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]),
    '随机 200 字节': Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37) % 256)),
  }
  for (const [name, bytes] of Object.entries(cases)) {
    // 不抛异常、且必须是 null（像素炸弹藏在「读不出却放过」里，所以读不出必须判不了 = null → 拒绝）
    let out
    assert.doesNotThrow(() => { out = readImageDimensions(bytes) }, name + ' 不能抛异常')
    assert.equal(out, null, name + ' 读不出尺寸必须返回 null（不能瞎猜）')
  }
})
