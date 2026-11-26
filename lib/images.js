/**
 * issue / PR 里的图片 → 本地文件（v1）。
 *
 * 为什么需要这个模块：DSH 宿主自带工具 `read_image`（参数 `file_path`，读本地
 * PNG/JPEG/WebP/GIF 并把图片本身返回给模型；实现见宿主的 dsh-tool-fs）。
 * 唤醒消息是纯文本，模型看不到 issue / 评论里贴的截图 —— 真机实测：issue 只贴了截图时，
 * 处理会话只能回「拿不到图片内容」。所以服务端先把图下到本地，唤醒文本里给**绝对路径**，
 * 模型自己 read_image 就能看见。
 *
 * 三条刻意划定的边界：
 * 1. 只下 https + GitHub 图片域（见 `isAllowedImageUrl`）。其它域名一律拒绝 —— 防 SSRF：
 *    issue 的正文是陌生人写的，不能让一条链接把会话引导去打内网 / 云元数据。
 * 2. 下载失败**只返回、不抛错**：图片是唤醒的附加信息，下不动不该让整条唤醒消失。
 * 3. 有界：张数（默认 6）、字节数（默认 10 MiB）、超时（默认 20s，AbortController）都有上限；
 *    一张超时或超限不影响其它张。
 *
 * GitHub 附件下载的两种姿势（都是真机踩过的坑）：
 * - `https://github.com/user-attachments/assets/<uuid>`：第一跳必须带
 *   `Authorization: Bearer <token>` 和 `Accept: application/octet-stream`；GitHub 回 302
 *   到 `github-production-user-asset-*.s3.amazonaws.com` 的**预签名** URL。第二跳必须
 *   **去掉 Authorization**：S3 看到「预签名 + Bearer」两个签名会回 403（或干脆空 body）。
 *   所以这里用 `redirect: 'manual'` 自己跟跳转，而不是让 fetch 跟。
 * - `private-user-images.githubusercontent.com/...`：URL 自带 jwt，直接 GET，不要带
 *   Authorization；`camo.githubusercontent.com` 同理直接 GET。
 *
 * 本模块不依赖 Cordis / 状态目录 / 网络抓取默认值，全部 I/O 走注入，便于离线测试。
 *
 * **默认传输层不用全局 `fetch`**：真机（企业网 / 加速器）常挂 TLS 中间人 ——
 * 实测 github.com 的证书由本机加速器的根证书签发，`fetch` 与 `curl` 都直接
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`（任务里的原话就是「curl 返回 0 字节」）。
 * 正确姿势是 Node 内置 https + `tls.getCACertificates('system')` 的系统信任库：
 * 同一张图首跳 302、去 auth 的二跳 200 `image/png`（实测 108515 字节）。
 * Node < 22.15 没有 getCACertificates 时返回 undefined，回退 Node 自带根证书。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import * as tls from 'node:tls'

/** 默认上限：每条 issue / PR 最多 6 张、单张 10 MiB、单张 10 秒。 */
export const DEFAULT_IMAGE_LIMITS = Object.freeze({
  maxCount: 6,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 20_000,
  // 整批预算（墙钟）。`lib/index.js` 一直按这个名字取：以前这里没这一项 →
  // `deadlineMs: undefined` → `budgetAt = Date.now() + undefined = NaN` →
  // `setTimeout(NaN)` 被 Node 压成 1ms → **生产路径每张图都「下载超时（NaN 秒）」**，
  // 而单测都是直接调 downloadImages 并手传预算，压根走不到 index.js 那组参数。
  deadlineMs: 45_000,
})

/** 最多跟几次重定向（GitHub 附件实测只跳一次，留余量但不许无限）。 */
const MAX_REDIRECTS = 3

/** 同时下几张：有界，避免一轮轮询把连接/内存打满。 */
const DOWNLOAD_CONCURRENCY = 4

/** 进程级并发闸门（所有 repo / 所有 issue 共用）：最多 DOWNLOAD_CONCURRENCY 个在飞。 */
let activeDownloads = 0
const downloadQueue = []
function globalSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeDownloads += 1
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeDownloads -= 1
          const next = downloadQueue.shift()
          if (next) next()
        })
    }
    if (activeDownloads < DOWNLOAD_CONCURRENCY) run()
    else downloadQueue.push(run)
  })
}

/** 响应头 → 扩展名。只认 read_image 支持的四种。 */
const CONTENT_TYPE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** 扩展名 → mediaType（写进返回值的规范形式）。 */
const EXT_MEDIA_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** 明显不是图片的扩展名：提取阶段就丢掉，避免白跑一趟下载。 */
const NON_IMAGE_EXT = /\.(?:html?|xhtml|pdf|zip|tar|gz|tgz|txt|json|js|mjs|css|md|svg|mp4|mov|webm|mp3|wav|xml|yml|yaml)$/i

/**
 * 提取正文里的图片 URL（去重、按出现顺序）。
 *
 * 为什么四种写法都要认：GitHub 的 issue / 评论正文是 markdown，但客户经常直接粘
 * `<img>`（网页复制）或引用式图片（把图片定义放到文末，含 `![alt]` 这种简写引用）。
 * 漏一种，模型就看不到那张图，而正文里其它文字照常出现 —— 静默。`data:` 与相对路径
 * **不**收：前者不是 URL，后者没有可下载的绝对地址。
 *
 * 引用定义的 id 按 CommonMark 归一（忽略大小写、压缩空白）；`![alt][]` 用 alt 当 id。
 *
 * @param {string} text 正文（null / 非字符串按空处理）
 * @returns {string[]} 按出现顺序的 http(s) 图片 URL
 */
const EXTRACT_LIMITS = Object.freeze({
  maxInputChars: 200_000,
  maxRegexMs: 40,
  maxUrls: 32,
})

export function extractImageUrls(text) {
  const rawText = String(text ?? '')
  if (rawText.length === 0) return []
  // 扫描预算：GitHub 正文上限 65536、陌生人可控。审计实测 65KB 的 `![` 洪泛让
  // 旧正则跑 4807ms（事件循环饿住 8.5s）。三条上限：输入长度、正则总耗时、命中条数。
  // 超了宁可少提取，也不许卡住宿主。
  const startedAt = Date.now()
  const overBudget = () => Date.now() - startedAt > EXTRACT_LIMITS.maxRegexMs
  const source = rawText.length > EXTRACT_LIMITS.maxInputChars
    ? rawText.slice(0, EXTRACT_LIMITS.maxInputChars)
    : rawText
  if (!source) return []
  const definitions = referenceDefinitions(source)
  const out = []
  const seen = new Set()
  // 一个正则同时匹配四种写法，才能保住「真实出现顺序」：
  //   ① 行内图片 ![alt](url "title")，url 允许 <...> 包裹
  //   ② 引用式 ![alt][ref]，ref 为空时用 alt 当 id
  //   ③ 简写引用式 ![alt]（只有存在同名定义时才算图片）
  //   ④ HTML <img src="...">（双引号 / 单引号 / 裸属性）
  // 顺序不能调：正则在同一位置按分支先后试，行内/引用必须先于简写，
  // 否则 `![a](url)` 会被简写分支截成 `![a]`。
  // **线性扫描**而不是一个超复杂的正则：旧实现在 65KB 的 '![' 洪泛上要跑 4.8 秒
  // （审计实测，事件循环被饿住 8.5s，而 GitHub 正文上限正好 65536，陌生人可打）。
  // 这里用 indexOf 步进 + 小窗口正则，复杂度与输入长度线性相关；命中条数与耗时另有上限。
  const INLINE = /^!\[([^\]]*)\]\(\s*(<[^>\s]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/
  const REF = /^!\[([^\]]*)\]\[([^\]]*)\]/
  const SHORT = /^!\[([^\]]*)\]/
  const IMG = /^<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
  let index = 0
  while (index < source.length) {
    if (out.length >= EXTRACT_LIMITS.maxUrls || overBudget()) break
    const bang = source.indexOf('![', index)
    const tag = source.toLowerCase().indexOf('<img', index)
    let next
    if (bang < 0 && tag < 0) break
    if (bang < 0) next = tag
    else if (tag < 0) next = bang
    else next = Math.min(bang, tag)
    const head = source.slice(next, next + 8192)
    let consumed = 0
    let raw = ''
    let match
    // 行内 / 引用 / 简写（必须按此顺序，否则 `![a](url)` 会被简写分支截成 `![a]`）
    if ((match = INLINE.exec(head))) {
      raw = match[2]
      consumed = match[0].length
    } else if ((match = REF.exec(head))) {
      const id = String(match[2] ?? '').trim() || String(match[1] ?? '')
      raw = definitions.get(normalizeRefId(id)) || ''
      consumed = match[0].length
    } else if ((match = SHORT.exec(head))) {
      raw = definitions.get(normalizeRefId(match[1])) || ''
      consumed = match[0].length
    } else if (tag === next && (match = IMG.exec(head))) {
      raw = match[1] ?? match[2] ?? match[3] ?? ''
      consumed = match[0].length
    }
    if (consumed === 0) { index = next + 1; continue }
    pushImageUrl(out, seen, raw)
    index = next + consumed
  }
  return out
}

/** 收集 `[id]: https://...` 形式的图片 / 链接引用定义。 */
function referenceDefinitions(source) {
  const map = new Map()
  const pattern = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?/gm
  let match
  const startedAt = Date.now()
  while ((match = pattern.exec(source)) !== null) {
    if (map.size >= EXTRACT_LIMITS.maxUrls || Date.now() - startedAt > EXTRACT_LIMITS.maxRegexMs) break
    const id = normalizeRefId(match[1])
    if (id && !map.has(id)) map.set(id, match[2])
  }
  return map
}

function normalizeRefId(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** 归一化单个候选地址：只留 http(s) 且不是「明显不是图片」的链接。 */
function pushImageUrl(out, seen, raw) {
  const url = String(raw ?? '').trim().replace(/^<|>$/g, '')
  if (!url) return
  if (/^data:/i.test(url)) return
  if (!/^https?:\/\//i.test(url)) return
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
  if (NON_IMAGE_EXT.test(parsed.pathname)) return
  if (seen.has(url)) return
  seen.add(url)
  out.push(url)
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/** 按 host 判断（不含路径）：白名单是「域名」而不是「某几个 URL」。 */
function normalizedHost(hostname) {
  return String(hostname ?? '').toLowerCase().replace(/\.+$/, '')
}

/**
 * 这个 URL 能不能下？—— 白名单 + https + 无凭证 + 常规端口。
 *
 * 允许的域（全部是 GitHub 自己发图片用的，超集就足够覆盖 issue / PR 里的图）：
 * - `github.com`（`/user-attachments/assets/<uuid>` 附件入口；会 302 到下面的 S3）
 * - `*.githubusercontent.com`：`private-user-images` / `user-images` / `camo` / `objects`
 * - `github-production-user-asset-*.s3.amazonaws.com`（附件 302 的落点，预签名 URL）
 *
 * 拒绝的理由写在这里，因为**调用方要把它写进唤醒文本**：客户看到「图片没下载成功」
 * 时必须能明白是「这个域名我们不碰」，而不是以为功能坏了。
 */
export function isAllowedImageUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw ?? ''))
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.port && parsed.port !== '443') return false
  const host = normalizedHost(parsed.hostname)
  if (GITHUB_HOSTS.has(host)) return true
  if (host.endsWith('.githubusercontent.com')) return true
  // 附件 302 的落点；也认地区化 endpoint（s3.us-east-1.amazonaws.com），
  // 但仍然死死限定在 github-production-user-asset-* 这个桶名下。
  if (/^github-production-user-asset-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host)) return true
  return false
}

/** 只给 github.com 的附件入口带 token；任何其它域（含 302 之后的 S3）都不带。 */
function bearerFor(raw, token) {
  const value = String(token ?? '')
  if (!value) return ''
  let parsed
  try {
    parsed = new URL(String(raw ?? ''))
  } catch {
    return ''
  }
  if (!GITHUB_HOSTS.has(normalizedHost(parsed.hostname))) return ''
  if (!parsed.pathname.startsWith('/user-attachments/assets/')) return ''
  return value
}

/** 请求头：附件入口才带 Bearer + octet-stream，其它域一律裸 GET。 */
function requestHeaders(url, token) {
  const headers = {}
  if (bearerFor(url, token)) {
    headers.authorization = 'Bearer ' + String(token).trim()
    headers.accept = 'application/octet-stream'
  }
  return headers
}

/** 仓库名 → 安全目录名（`acme/repo` → `acme-repo`；Windows 不允许 `:` `/` 等字符）。 */
export function repoDirName(repo) {
  const text = String(repo ?? '').trim()
    .replace(/^gitee:/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // 首尾点号会让路径变成 . / ..（Windows 也认），必须剥掉
    .replace(/^\.+|\.+$/g, '')
  // 清洗会把 'acme/repo' 与 'acme-repo' 压成同一个名字 —— 多仓时图片串仓（审计）。
  // 名字不同就追加名字的短 hash，保证不同 repo 一定落到不同目录。
  const base = text || 'repo'
  const alias = createHash('sha256').update(String(repo ?? '')).digest('hex').slice(0, 6)
  return base + '-' + alias
}

/** 正文里某个 issue / PR 的图片目录：`<state>/images/<repo>/<kind>-<number>`。 */
export function imageDirFor(stateRoot, repo, kind, number) {
  const safeNumber = /^\d+$/.test(String(number)) ? String(number) : 'unknown'
  const safeKind = String(kind) === 'pr' ? 'pr' : 'issue'
  return join(String(stateRoot), 'images', repoDirName(repo), safeKind + '-' + safeNumber)
}

/**
 * 下载图片到 `dir`。**不抛错**：任何一张失败都落在 `failures` 里，调用方照常唤醒。
 *
 * @param {object} options
 * @param {string[]} options.urls 候选地址（顺序保留，超出 maxCount 的截断）
 * @param {string} options.dir 保存目录（不存在会自动建）
 * @param {string} [options.token] GitHub 凭证（只在附件入口那一跳使用）
 * @param {Function} [options.fetchImpl] 注入的 fetch（默认 globalThis.fetch）
 * @param {number} [options.maxBytes] 单张字节上限
 * @param {number} [options.maxCount] 张数上限
 * @param {number} [options.timeoutMs] 单张超时（毫秒）
 * @param {number} [options.deadlineMs] 整批预算（毫秒）：到点后的图片直接记「预算用完」
 * @returns {Promise<{files: Array<{path: string, url: string, bytes: number, mediaType: string}>, failures: Array<{url: string, reason: string}>}>}
 */
export async function downloadImages(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const all = (Array.isArray(opts.urls) ? opts.urls : []).map((url) => String(url ?? '')).filter(Boolean)
  const maxCount = budgetInt(opts.maxCount, DEFAULT_IMAGE_LIMITS.maxCount, 'maxCount')
  const maxBytes = budgetInt(opts.maxBytes, DEFAULT_IMAGE_LIMITS.maxBytes, 'maxBytes')
  const timeoutMs = budgetInt(opts.timeoutMs, DEFAULT_IMAGE_LIMITS.timeoutMs, 'timeoutMs')
  const deadlineMs = budgetInt(opts.deadlineMs, DEFAULT_IMAGE_LIMITS.deadlineMs, 'deadlineMs')
  const budgetAt = Date.now() + deadlineMs
  const dir = String(opts.dir ?? '')
  const token = String(opts.token ?? '')
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : defaultTransport
  const results = { files: [], failures: [] }
  const urls = all.slice(0, maxCount)
  if (urls.length === 0) return results
  if (!dir) {
    for (const url of urls) results.failures.push({ url, reason: '没有可保存的目录' })
    return results
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    const reason = '建不了图片目录：' + shortError(error)
    for (const url of urls) results.failures.push({ url, reason })
    return results
  }
  if (typeof fetchImpl !== 'function') {
    for (const url of urls) results.failures.push({ url, reason: '当前环境没有可用的 fetch' })
    return results
  }
  // 有界并发（4）**且全局共享**：batchLimit=20 条 issue 一起轮询时，每 issue 各开 4 条
  // 就是 80 条并发连接（审计）；这里的信号量是整个进程共用的一份。
  // 另有整批预算：6 张 × 20 秒最坏 40 秒墙钟会把轮询拖住（真实撞到过 429）。
  const settled = await Promise.all(urls.map(async (url) => {
    if (Date.now() >= budgetAt) return { url, reason: '图片下载等待超时（本轮预算用完）' }
    // 单张超时取「单张上限」与「整批预算剩余」的较小者。
    //
    // 以前这里写的是 `Math.max(1000, budgetAt - Date.now())`（对抗审计打穿点 #3）：
    // ① 它**防不住 NaN** —— `Math.max(1000, NaN)` 仍然是 NaN（Math.max/min 一样传播 NaN），
    //    真正挡住 NaN 的是上游 `budgetInt` 抛错，这一层是冗余的误导性防护；
    // ② 它会把「整批预算只剩 < 1000ms」静默抬到 1000ms，等于篡改了调用方给的预算语义
    //    （预算快用完时还硬等 1 秒，正是想避免的「拖住轮询」）。
    // 现在直接用剩余时间：剩余 ≤ 0 已在上面 return，所以这里必然 > 0；
    // 仍取 max(1, …) 只为保证 clearTimeout 拿到正数（预算剩 0.4ms 时不要让 setTimeout 变 0）。
    const remaining = budgetAt - Date.now()
    return globalSlot(() => downloadOne(url, {
      dir, token, fetchImpl, maxBytes, timeoutMs: Math.min(timeoutMs, Math.max(1, remaining)),
    }))
  }))
  for (const item of settled) {
    if (item.file) results.files.push(item.file)
    else results.failures.push({ url: item.url, reason: item.reason })
  }
  return results
}

/** 一张图：白名单 → 跟随重定向（逐跳重算请求头）→ 尺寸 / 类型校验 → 落盘。 */
async function downloadOne(url, { dir, token, fetchImpl, maxBytes, timeoutMs }) {
  if (!isAllowedImageUrl(url)) {
    return { url, reason: '不在 GitHub 图片白名单（只下 https 的 GitHub 图片域，防 SSRF）' }
  }
  // 文件名只由 URL 决定：同一条 issue 反复唤醒时命中已有文件就不再走网络。
  const reused = existingImage(dir, url)
  if (reused) return { url, file: reused }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await followRedirects(url, { token, fetchImpl, signal: controller.signal, maxBytes })
    if (!response.ok) {
      // 302 循环 / 无 location / 403 / 404 都在这里收口；带上状态码，客户能自己判断是不是权限。
      // 不读 body 的响应必须排空，否则 socket 不能复用（审计实测：3 次 302 留 3 条连接）。
      discardResponse(response)
      return { url, reason: 'HTTP ' + response.status }
    }
    const contentType = String((response.headers && response.headers.get('content-type')) || '')
      .split(';')[0].trim().toLowerCase()
    const declared = countInt(response.headers && response.headers.get('content-length'), 0)
    if (declared > maxBytes) {
      discardResponse(response)
      return { url, reason: '图片超过大小上限（' + mib(maxBytes) + '）' }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) return { url, reason: '图片超过大小上限（' + mib(maxBytes) + '）' }
    const actual = detectImageType(bytes)
    if (!actual) {
      return { url, reason: '不是支持的图片（png/jpg/webp/gif；响应头 ' + (contentType || '空') + '）' }
    }
    const declaredExt = CONTENT_TYPE_EXT[contentType] || extFromUrl(url)
    if (declaredExt && declaredExt !== actual.ext) {
      return { url, reason: '类型不符：声明是 ' + declaredExt + '，字节是 ' + actual.ext + '，跳过' }
    }
    // 文件名只由 URL 决定：同一条 issue 反复唤醒时路径稳定，模型/日志里能对上。
    const name = createHash('sha256').update(url).digest('hex').slice(0, 12) + '.' + actual.ext
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return { url, file: { path, url, bytes: bytes.length, mediaType: actual.mediaType } }
  } catch (error) {
    if (error && error.code === 'IMAGE_TOO_LARGE') {
      return { url, reason: '图片超过大小上限（' + mib(maxBytes) + '）' }
    }
    const aborted = controller.signal.aborted || (error && error.name === 'AbortError')
    const secs = timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) + ' 秒' : '不足 1 秒'
    return { url, reason: aborted ? '下载超时（' + secs + '）' : '请求失败：' + shortError(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 自己跟重定向：每一跳都重新算请求头（Authorization 不许跟到 S3 去）。 */
async function followRedirects(url, { token, fetchImpl, signal, maxBytes }) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: requestHeaders(current, token),
      signal,
      maxBytes,
    })
    const status = Number(response.status)
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308
    if (!isRedirect) return response
    const location = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location')
      : null
    if (!location) {
      discardResponse(response)
      return response
    }
    discardResponse(response)
    const next = new URL(String(location), current).toString()
    // 重定向目标也要过白名单：否则一条 302 就能把请求带去内网（白名单被绕过）
    if (!isAllowedImageUrl(next)) throw new Error('重定向目标不在白名单：' + normalizedHost(new URL(next).hostname))
    current = next
  }
  throw new Error('重定向次数过多（超过 ' + MAX_REDIRECTS + ' 次）')
}

/**
 * 响应体超限：单独的错误类型，让 downloadOne 能翻成「图片超过大小上限」。
 * 旧实现先 res.destroy() 再 fail()，'aborted' 先把 Promise 结算掉，
 * 客户看到的是「请求失败：响应被中断」—— 文案与事实不符（审计实测）。
 */
export class ImageTooLargeError extends Error {
  constructor(limitBytes) {
    super('响应超过大小上限')
    this.name = 'ImageTooLargeError'
    this.code = 'IMAGE_TOO_LARGE'
    this.limitBytes = limitBytes
  }
}

/**
 * 默认传输层工厂：Node 内置 https + 系统根证书（fetch 兼容的小接口）。
 *
 * 为什么不用全局 fetch：真机（企业网 / 加速器）常挂 TLS 中间人，fetch 与 curl 都
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE；https + tls.getCACertificates('system') 才通。
 *
 * 为什么做成工厂：request 可换成 node:http 的 request，让测试指向本地服务器，
 * 真实覆盖 302 / 无 content-length 的超大响应 / 丢弃响应体 等生产路径行为
 * （审计指出：旧实现「生产唯一传输层零测试」，变异掉字节也全绿）。
 *
 * 两个刻意的行为：
 * - 超限在流式读取时掐断，并对 downloadOne 暴露 ImageTooLargeError；
 * - 每个响应都要么读完、要么 discard()（resume），否则 socket 不复用（慢泄漏）。
 */
/** 系统信任库 + Node 默认根证书（合并去重，缓存一次；取不到就回退 Node 默认）。 */
let cachedCaBundle
function systemCaBundle() {
  if (cachedCaBundle !== undefined) return cachedCaBundle
  cachedCaBundle = null
  try {
    if (typeof tls.getCACertificates === 'function') {
      const system = tls.getCACertificates('system') || []
      const fallback = tls.getCACertificates('default') || []
      const merged = [...new Set([...system, ...fallback])]
      if (merged.length > 0) cachedCaBundle = merged
    }
  } catch {
    cachedCaBundle = null
  }
  return cachedCaBundle
}

export function createTransport({ request = httpsRequest, ca = () => systemCaBundle() } = {}) {
  return function transport(url, init = {}) {
    const headers = { ...(init.headers || {}) }
    const bundle = typeof ca === 'function' ? ca() : ca
    const limit = Number(init.maxBytes) > 0 ? Number(init.maxBytes) : 0
    return new Promise((resolve, reject) => {
      const req = request(String(url), {
        method: init.method || 'GET',
        headers,
        ...(bundle ? { ca: bundle } : {}),
      }, (res) => {
        let discarded = false
        let settled = false
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          fn(value)
        }
        const response = {
          status: res.statusCode,
          ok: Number(res.statusCode) >= 200 && Number(res.statusCode) < 300,
          headers: {
            get(name) {
              const value = res.headers[String(name).toLowerCase()]
              if (value === undefined) return null
              return Array.isArray(value) ? value[0] : String(value)
            },
          },
          // 不读 body 就结束的响应必须排空，否则连接不能复用
          discard() {
            discarded = true
            try { res.resume() } catch { /* 已销毁就算了 */ }
          },
          arrayBuffer() {
            if (discarded) return Promise.reject(new Error('响应已被丢弃'))
            return new Promise((done, fail) => {
              const chunks = []
              let total = 0
              res.on('data', (chunk) => {
                total += chunk.length
                if (limit > 0 && total > limit) {
                  finish(fail, new ImageTooLargeError(limit))
                  try { res.destroy() } catch { /* 已结束 */ }
                  return
                }
                chunks.push(chunk)
              })
              res.on('end', () => finish(done, Buffer.concat(chunks)))
              res.on('error', (error) => finish(fail, error))
              res.on('aborted', () => finish(fail, new Error('响应被中断')))
            })
          },
        }
        resolve(response)
      })
      req.on('error', reject)
      const signal = init.signal
      if (signal) {
        if (signal.aborted) {
          const aborted = new Error('aborted')
          aborted.name = 'AbortError'
          req.destroy(aborted)
          return
        }
        const onAbort = () => {
          const aborted = new Error('aborted')
          aborted.name = 'AbortError'
          req.destroy(aborted)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        req.on('close', () => signal.removeEventListener('abort', onAbort))
      }
      req.end()
    })
  }
}

const defaultTransport = createTransport()

/** 不读 body 就结束的响应：排空 / 取消，让 socket 能复用。注入的假 fetch 没有这些就 no-op。 */
function discardResponse(response) {
  if (!response) return
  try {
    if (typeof response.discard === 'function') response.discard()
    else if (response.body && typeof response.body.cancel === 'function') response.body.cancel().catch(() => {})
  } catch { /* 已经结束/销毁就无所谓 */ }
}

/** 已下载过的同一 URL（文件名 = URL 的 sha256 前 12 位）：命中就复用，不再走网络。 */
function existingImage(dir, url) {
  const prefix = createHash('sha256').update(url).digest('hex').slice(0, 12)
  try {
    const name = readdirSync(dir).find((entry) => entry.startsWith(prefix + '.')
      && /\.(png|jpg|gif|webp)$/i.test(entry))
    if (!name) return null
    const path = join(dir, name)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const mediaType = ext === 'jpg' ? EXT_MEDIA_TYPE.jpg : EXT_MEDIA_TYPE[ext]
    if (!mediaType) return null
    return { path, url, bytes: statSync(path).size, mediaType }
  } catch {
    return null
  }
}

/** 按字节魔数判类型。判断不出返回 null（调用方按「不是图片」跳过）。 */
function detectImageType(bytes) {
  if (!bytes || bytes.length < 3) return null
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { ext: 'png', mediaType: EXT_MEDIA_TYPE.png }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mediaType: EXT_MEDIA_TYPE.jpg }
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString('latin1')
    if (head === 'GIF87a' || head === 'GIF89a') return { ext: 'gif', mediaType: EXT_MEDIA_TYPE.gif }
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', mediaType: EXT_MEDIA_TYPE.webp }
  }
  return null
}

/** URL 路径里的扩展名（camo / 附件这种没扩展名的 URL 返回 null，交给字节判断）。 */
function extFromUrl(url) {
  let pathname = ''
  try {
    pathname = new URL(String(url ?? '')).pathname
  } catch {
    return null
  }
  const match = pathname.toLowerCase().match(/\.([a-z0-9]+)$/)
  if (!match) return null
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  return EXT_MEDIA_TYPE[ext] ? ext : null
}

/**
 * 取一个正整数**预算**参数（`deadlineMs` / `timeoutMs` / `maxBytes` / `maxCount`）。
 *
 * `fallback` 为 `undefined` / 非正数时**直接抛错**，不要静默放行。
 * 为什么（2026-11-26 真机）：`DEFAULT_IMAGE_LIMITS` 曾漏了 `deadlineMs`，
 * `positiveInt(undefined, undefined)` 返回 `undefined` → `Date.now() + undefined = NaN`
 * → `setTimeout(NaN)` 被 Node 压成 **1ms** → 生产路径每张图都「下载超时（NaN 秒）」，
 * 而单测都是直接调 `downloadImages` 并手传预算，全绿也发现不了。
 * 预算类参数算不出来就是**编程错误**，宁可在入口炸掉，也不要静默降级成 1ms
 * 在用户面前失败。
 *
 * 语义约定：**`0` / 负数 / NaN = 非法**，一律回落到 `fallback`（正数）。
 * 没有「`0` = 不限时」「`0` = 不下载」这种语义 —— 要「不下载」请把 `urls` 传空数组，
 * 要「不限时」请给一个足够大的正数（例如 `24 * 3600_000`）。
 * 为什么不支持 `0`：`setTimeout(0)` 会变成「立即超时」，`maxCount: 0` 会变成「一张不下」
 * 但调用方以为在配置预算 —— 这种「显式 0 被静默改写」的歧义比直接回落默认更危险。
 */
function budgetInt(value, fallback, name) {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return Math.floor(number)
  const back = Number(fallback)
  if (!Number.isFinite(back) || back <= 0) {
    throw new TypeError('图片下载预算参数缺失或非法：' + name + '（这通常是 DEFAULT_IMAGE_LIMITS 漏了字段或传了 undefined）')
  }
  return Math.floor(back)
}

/**
 * 取一个非负整数**普通**参数（例如响应头里的 `content-length`，可能缺失）。
 * 缺失或非法就用兜底，不抛错 —— 它不参与超时/预算计算，缺了不致命。
 */
function countInt(value, fallback = 0) {
  const number = Number(value)
  if (Number.isFinite(number) && number >= 0) return Math.floor(number)
  const back = Number(fallback)
  return Number.isFinite(back) && back >= 0 ? Math.floor(back) : 0
}

/** 仅供测试：预算参数解析（兜底缺失时会抛错，见 budgetInt 的注释）。 */
export const __test = { budgetInt }

function mib(bytes) {
  const value = Number(bytes) / (1024 * 1024)
  return (Number.isInteger(value) ? value : value.toFixed(1)) + ' MiB'
}

function shortError(error) {
  const text = String((error && error.message) || error || '').replace(/\s+/g, ' ').trim()
  return [...text].slice(0, 80).join('') || '未知错误'
}

/**
 * 唤醒文本里的图片段（一行）。
 *
 * 措辞是给模型看的**操作指令**：说清楚「图已经在本机哪个绝对路径上」+「用 read_image」，
 * 否则模型即使看到路径也不知道该调什么工具（实测会话会回「我拿不到图片」）。
 * 失败只报第一张的原因（客户只需要知道为什么没图），截到 60 字保证整行可控。
 *
 * @param {{label?: string, files?: Array<{path?: string}>, failures?: Array<{reason?: string}>, maxInText?: number}} options
 * @returns {string[]} 0 或 1 行；没有图也没有失败时返回空数组（不许凭空造一段）
 */
export function imageNoteLines(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const label = String(opts.label ?? '').trim()
  const files = Array.isArray(opts.files) ? opts.files : []
  const failures = Array.isArray(opts.failures) ? opts.failures : []
  // 与 budgetInt 同一约定：`0` / 非法视为「未配置」并回落默认。否则 `maxInText: 0`
  // 会变成「一张都不列」（正文只剩「另有 N 张」却不给任何路径），是没人想要的怪语义。
  const maxInTextRaw = countInt(opts.maxInText, 0)
  const maxInText = maxInTextRaw > 0 ? maxInTextRaw : DEFAULT_IMAGE_LIMITS.maxCount
  const paths = files.map((file) => String((file && file.path) || '')).filter(Boolean)
  if (paths.length === 0) {
    if (failures.length === 0) return []
    const why = shortReason(failures[0] && failures[0].reason)
    return ['【图片】' + label + ' 的 ' + failures.length + ' 张图下载失败：' + why]
  }
  const shown = paths.slice(0, maxInText)
  // 路径可能含空格（Windows 用户名 / 目录）；空格分隔多个路径时模型切不出单个 file_path，
  // 所以每个路径都用反引号包住。
  const quoted = shown.map((path) => String.fromCharCode(96) + path + String.fromCharCode(96))
  const more = paths.length > shown.length ? ' …另有 ' + (paths.length - shown.length) + ' 张' : ''
  const failed = failures.length > 0
    ? '（' + failures.length + ' 张下载失败：' + shortReason(failures[0] && failures[0].reason) + '）'
    : ''
  return [
    '【图片】' + label + ' 有 ' + paths.length + ' 张图已存本地，用 read_image 读取：'
    + quoted.join(' ') + more + failed,
  ]
}

/** 失败原因截到 60 字（唤醒文本是单行预算，原因只是提示）。 */
function shortReason(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return [...text].slice(0, 60).join('') || '未知原因'
}

/** 「接下来：」是唤醒文本的收尾指令段落起点（`mergeWakeTexts` 也以它为尾巴分界）。 */
const WAKE_TAIL_MARK = /^接下来：/m

/**
 * 把图片段并进唤醒文本。
 *
 * **不能简单 `text + lines`**：唤醒窗口内多条唤醒会被 `mergeWakeTexts` 合并，它把
 * 「接下来：」之后的内容当作尾巴、**只保留第一条**。图片段要是落在尾巴里，合并时
 * 后面几条的绝对路径就静默消失（模型只看到第一张图，其余当没发生）。所以插在
 * 「接下来：」之前；PR 文本没有这一段，直接追加到末尾。
 *
 * @param {string} text 唤醒文本
 * @param {string[]} lines 图片段（0~1 行，来自 imageNoteLines）
 * @returns {string} 合并后的文本（没有图片段时原样返回）
 */
export function appendImageLines(text, lines) {
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean)
  if (list.length === 0) return text
  const body = String(text || '')
  const block = list.join('\n')
  // **行首**才算收尾指令：评论正文是引用块（`> 接下来：…`），不能被当成唤醒的收尾段落，
  // 否则图片段会插进别人的引文正中间。
  const tail = WAKE_TAIL_MARK.exec(body)
  if (!tail) return body ? body + '\n\n' + block : block
  return body.slice(0, tail.index).replace(/\s+$/, '') + '\n\n' + block + '\n\n' + body.slice(tail.index)
}