// 生产传输层（lib/images.js 的 createTransport）的真实 I/O 测试。
//
// 为什么单独一个文件：审计指出「生产唯一传输层零测试，变异掉字节也 24 条全绿」。
// 这里用 node:http 的 request 替换 https 的 request，把 transport 指向本地服务器 ——
// 不触网、却能真实覆盖 resolve 后读 body 不丢包、流式超限、丢弃响应体与连接复用、
// 预中止这些只有真实 socket 才暴露的行为。
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { createTransport, ImageTooLargeError } from '../lib/images.js'

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port))
})
const close = (server) => new Promise((resolve) => server.close(resolve))
const transport = createTransport({ request: httpRequest })

test('传输层：status / ok / headers.get 正确，resolve 后延迟读 body 不丢字节', async () => {
  const body = Buffer.alloc(1024 * 1024, 7)
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) })
    res.end(body)
  })
  const url = await listen(server)
  try {
    const response = await transport(url)
    assert.equal(response.status, 200)
    assert.equal(response.ok, true)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('x-not-there'), null, '缺失头必须是 null（不是 undefined 字符串）')
    // 延迟再读：resolve 时还没挂 data 监听，流必须处于暂停态而不是继续丢数据
    await new Promise((resolve) => setTimeout(resolve, 120))
    const got = Buffer.from(await response.arrayBuffer())
    assert.equal(got.length, body.length, '字节数必须与响应一致（丢包会让图片损坏）')
    assert.equal(got.compare(body), 0, '内容必须逐字节一致')
  } finally {
    await close(server)
  }
})

test('传输层：没有 content-length 的超大响应在 maxBytes 处掐断并报 ImageTooLargeError', async () => {
  const chunk = Buffer.alloc(64 * 1024, 1)
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    let sent = 0
    const pump = () => {
      if (sent >= 2 * 1024 * 1024) return res.end()
      sent += chunk.length
      if (!res.write(chunk)) res.once('drain', pump)
      else setImmediate(pump)
    }
    pump()
    res.on('error', () => {})
  })
  const url = await listen(server)
  try {
    const response = await transport(url, { maxBytes: 64 * 1024 })
    await assert.rejects(() => response.arrayBuffer(), (error) => {
      assert.ok(error instanceof ImageTooLargeError, '必须是可识别的超限错误（不是「响应被中断」）')
      assert.equal(error.code, 'IMAGE_TOO_LARGE')
      return true
    })
  } finally {
    server.closeAllConnections()
    await close(server)
  }
})

test('传输层：discard 会排空响应体，连接可以复用（不读 body 的早退不泄漏 socket）', async () => {
  let connections = 0
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4096' })
    res.end(Buffer.alloc(4096, 2))
  })
  server.on('connection', () => { connections += 1 })
  const url = await listen(server)
  try {
    const first = await transport(url)
    first.discard()
    await assert.rejects(() => first.arrayBuffer(), /已被丢弃/)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const second = await transport(url)
    await second.arrayBuffer()
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(connections, 1, '第一次 discard 后连接应被复用；连接数 >1 说明响应体没排空')
  } finally {
    await close(server)
  }
})

test('传输层：调用前已 abort 的 signal 直接拒绝为 AbortError', async () => {
  const server = createServer((req, res) => res.end('x'))
  const url = await listen(server)
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => transport(url, { signal: controller.signal }), (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    })
  } finally {
    await close(server)
  }
})