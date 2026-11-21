import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CapabilityError,
  defineProvider,
  requireCapability,
  issueCursor,
  createGithubProvider,
  createGiteeProvider,
  runProviderConformance,
} from '../lib/rooms/data-provider.js'

const sample = { number: 7, title: 'demo', state: 'open', labels: [], assignees: [] }

function minimalProvider() {
  return defineProvider({
    name: 'fake',
    list: async () => ({ ok: true, items: [sample] }),
    keyOf: (item) => `issue:${item.number}`,
    cursorOf: (item) => `v:${item.title}`,
    compareCursor: (left, right) => left === right,
  })
}

test('数据源房：必需针脚缺一不可，不能用空方法冒充', () => {
  assert.throws(() => defineProvider({ name: 'bad', cursorOf: () => 'x', compareCursor: () => true }), /list/)
  assert.throws(() => defineProvider({
    name: 'bad', capabilities: ['issues', 'comments'], list: async () => {},
    keyOf: () => 'k', cursorOf: () => 'x', compareCursor: () => true,
  }), /listComments/)
})

test('数据源房：最小只读 provider 只需四个必需针脚', async () => {
  const provider = minimalProvider()
  assert.deepEqual(provider.capabilities(), ['issues'])
  assert.equal(provider.listComments, undefined)
  assert.equal(provider.acknowledge, undefined)
  assert.deepEqual((await provider.list({ repo: 'o/r' })).items, [sample])
})

test('数据源房：请求未声明能力必须显式报错，不静默降级', () => {
  const provider = minimalProvider()
  assert.throws(() => requireCapability(provider, 'comments'), (error) => {
    assert.ok(error instanceof CapabilityError)
    assert.equal(error.capability, 'comments')
    return true
  })
})

test('数据源房：语义 cursor 稳定、排除 ack 标签、真实内容变化会改变', () => {
  const base = {
    ...sample, body: 'body', user: { login: 'a' }, assignees: [{ login: 'z' }],
    labels: [{ name: 'bug' }, { name: '主理鱼:已处理' }], comments: 1,
  }
  const reordered = { ...base, labels: [{ name: '主理鱼:已处理' }, { name: 'bug' }] }
  assert.equal(issueCursor(base, { ackLabel: '主理鱼:已处理' }), issueCursor(reordered, { ackLabel: '主理鱼:已处理' }))
  assert.notEqual(issueCursor(base), issueCursor({ ...base, title: 'changed' }))
  assert.notEqual(issueCursor(base), issueCursor({ ...base, comments: 2 }))
  assert.notEqual(issueCursor(base), issueCursor({ ...base, body: 'edited' }))
})

test('数据源房：GitHub list 复用 --include/ETag，CRLF 正文解析与截断标记', async () => {
  const calls = []
  const body = JSON.stringify([sample])
  const provider = createGithubProvider({
    run: async (file, args) => {
      calls.push({ file, args })
      return { code: 0, stdout: `HTTP/2 200\r\netag: "v2"\r\n\r\n${body}`, stderr: '' }
    },
  })
  const out = await provider.list({ repo: 'o/r', etag: '"v1"', perPage: 20 })
  assert.equal(out.ok, true)
  assert.equal(out.etag, '"v2"')
  assert.deepEqual(out.items, [sample])
  assert.equal(out.truncated, false)
  assert.deepEqual(calls[0].args.slice(0, 2), ['api', '--include'])
  assert.deepEqual(calls[0].args.slice(-2), ['-H', 'If-None-Match: "v1"'])
  const checks = await runProviderConformance(provider)
  assert.equal(checks.every((check) => check.ok), true)
})

test('数据源房：GitHub 失败结果脱敏，不把凭证带回模型', async () => {
  const token = 'ghp_12345678901234567890'
  const provider = createGithubProvider({
    run: async () => ({ code: 1, stdout: '', stderr: `Authorization: token ${token}` }),
  })
  const out = await provider.list({ repo: 'o/r' })
  assert.equal(out.ok, false)
  assert.equal(out.error.includes(token), false)
  assert.ok(out.error.includes('***'))
})

test('数据源房：Gitee list 复用现有归一，保留字符串 issue 编号', async () => {
  const provider = createGiteeProvider({
    token: '',
    fetchImpl: async (url) => ({
      ok: true, status: 200,
      text: async () => url.includes('/issues?')
        ? JSON.stringify([{ number: 'IKSQJH', title: 'g', body: 'body-g', state: 'open', updated_at: '2026-01-01' }])
        : JSON.stringify([]),
    }),
  })
  const out = await provider.list({ repo: 'o/r', perPage: 20 })
  assert.equal(out.ok, true)
  assert.equal(out.items[0].number, 'IKSQJH')
  assert.equal(out.items[0].state, 'open')
  assert.equal(out.items[0].body, 'body-g', 'Gitee 归一化不能丢掉正文语义')
  assert.equal(out.truncated, false)
  const checks = await runProviderConformance(provider)
  assert.equal(checks.every((check) => check.ok), true)
})

test('数据源房：Gitee 可选 ack 使用裸数组标签体', async () => {
  const writes = []
  const provider = createGiteeProvider({
    token: 'secret', acknowledge: undefined,
    fetchImpl: async (url, init) => {
      writes.push({ url, init })
      if (init.method === 'GET') return { ok: true, status: 200, text: async () => '[]' }
      return { ok: true, status: 200, text: async () => '{}' }
    },
  })
  assert.deepEqual(provider.capabilities(), ['issues', 'comments', 'ack'])
  const out = await provider.acknowledge({ repo: 'o/r', number: 'IKSQJH', label: '主理鱼-已处理', note: 'done' })
  assert.equal(out.ok, true)
  const addLabel = writes.find((call) => call.url.endsWith('/issues/IKSQJH/labels'))
  assert.equal(addLabel.init.body, '["主理鱼-已处理"]')
})

test('数据源房：可选评论针脚接上后才声明 comments 能力', () => {
  const without = createGithubProvider({ run: async () => ({ code: 0, stdout: 'HTTP/2 200\n\n[]' }) })
  assert.equal(without.capabilities().includes('comments'), false)
  const withComments = createGithubProvider({
    run: async () => ({ code: 0, stdout: 'HTTP/2 200\n\n[]' }),
    listComments: async () => ({ ok: true, at: null }),
  })
  assert.equal(withComments.capabilities().includes('comments'), true)
})

test('数据源房：同一一致性套件覆盖 fake/GitHub/Gitee', async () => {
  const providers = [
    minimalProvider(),
    createGithubProvider({ run: async () => ({ code: 0, stdout: 'HTTP/2 200\n\n[]' }) }),
    createGiteeProvider({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }) }),
  ]
  for (const provider of providers) {
    const checks = await runProviderConformance(provider)
    assert.ok(checks.length >= 5)
    assert.equal(checks.every((check) => check.ok), true, provider.name)
  }
})
