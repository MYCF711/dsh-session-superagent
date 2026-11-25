import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGithubProvider,
  createGiteeProvider,
  defineProvider,
} from '../lib/rooms/data-provider.js'
import {
  CapabilityError,
  DuplicateProviderError,
  ProviderNotFoundError,
  SourceRegistry,
  createSourceRegistry,
} from '../lib/rooms/source-registry.js'

const sample = { number: 7, title: 'demo', state: 'open', labels: [], assignees: [] }

function minimalProvider(name = 'fake', extra = {}) {
  return defineProvider({
    name,
    list: async () => ({ ok: true, items: [sample] }),
    keyOf: (item) => `issue:${item.number}`,
    cursorOf: (item) => `v:${item.title}`,
    compareCursor: (left, right) => left === right,
    ...extra,
  })
}

function githubProvider() {
  return createGithubProvider({
    run: async () => ({ code: 0, stdout: 'HTTP/2 200\r\n\r\n[]', stderr: '' }),
  })
}

function giteeProvider() {
  return createGiteeProvider({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }),
  })
}

test('Source 注册表：注册/获取保留 provider 身份，list 按名称确定排序且冻结', () => {
  const fake = minimalProvider()
  const registry = createSourceRegistry()
  assert.equal(registry.register(fake), fake)
  assert.equal(registry.get('fake'), fake)
  registry.register(minimalProvider('alpha'))
  assert.deepEqual(registry.list().map((provider) => provider.name), ['alpha', 'fake'])
  assert.equal(Object.isFrozen(registry.list()), true)
  assert.throws(() => registry.list().push(fake), TypeError)
})

test('Source 注册表：重复注册显式失败，不覆盖旧 provider，也不留下半次注册', () => {
  const first = minimalProvider('same', { listComments: async () => ({ ok: true }) })
  const second = minimalProvider('same')
  const registry = new SourceRegistry([first])
  assert.throws(() => registry.register(second), (error) => {
    assert.ok(error instanceof DuplicateProviderError)
    assert.equal(error.code, 'PROVIDER_DUPLICATE')
    assert.equal(error.provider, 'same')
    return true
  })
  assert.equal(registry.get('same'), first)
  assert.deepEqual(registry.list(), [first])
})

test('Source 注册表：未注册名称与缺能力都是显式错误', () => {
  const registry = createSourceRegistry([minimalProvider()])
  assert.throws(() => registry.get('missing'), (error) => {
    assert.ok(error instanceof ProviderNotFoundError)
    assert.equal(error.code, 'PROVIDER_NOT_FOUND')
    return true
  })
  assert.throws(() => registry.get('fake', 'comments'), (error) => {
    assert.ok(error instanceof CapabilityError)
    assert.equal(error.code, 'CAPABILITY_MISSING')
    assert.equal(error.provider, 'fake')
    assert.equal(error.capability, 'comments')
    return true
  })
  assert.throws(() => registry.requireCapability('fake', 'ack'), CapabilityError)
  assert.equal(registry.requireCapability('fake', 'issues'), true)
})

test('Source 注册表：原始 spec 复用 defineProvider 必需针脚与能力一致性校验', () => {
  const registry = createSourceRegistry()
  assert.throws(() => registry.register({ name: 'broken' }), /missing required pin: list/)
  assert.throws(() => registry.register({
    name: 'broken', capabilities: ['comments'],
    list: async () => ({ ok: true, items: [] }), keyOf: () => 'k', cursorOf: () => 'c', compareCursor: () => true,
  }), /declares comments but missing pin: listComments/)
  assert.equal(registry.list().length, 0)
  assert.throws(() => registry.register({ list: async () => {} }), /name is required/)
})

test('Source 注册表：可选能力路由到真实针脚，不静默降级', () => {
  const provider = minimalProvider('comments', { listComments: async () => ({ ok: true, at: null }) })
  const registry = createSourceRegistry([provider])
  assert.equal(registry.get('comments', 'comments'), provider)
  assert.equal(registry.requireCapability('comments', 'comments'), provider.listComments)
})

test('Source 注册表：GitHub/Gitee 可直接注册并保留各自能力', async () => {
  const github = githubProvider()
  const gitee = giteeProvider()
  const registry = createSourceRegistry([github, gitee])
  assert.deepEqual(registry.list().map((provider) => provider.name), ['gitee', 'github'])
  assert.deepEqual(registry.get('github').capabilities(), ['issues', 'ack'])
  assert.deepEqual(registry.get('gitee').capabilities(), ['issues', 'comments', 'ack'])
  assert.equal(registry.requireCapability('gitee', 'comments'), gitee.listComments)
  assert.throws(() => registry.requireCapability('github', 'comments'), CapabilityError)
  const listed = await registry.get('github').list({ repo: 'o/r' })
  assert.deepEqual(listed.items, [])
})

test('Source 注册表：实例之间无模块级共享状态，可独立重建', () => {
  const first = createSourceRegistry([minimalProvider('one')])
  const second = createSourceRegistry([minimalProvider('two')])
  assert.deepEqual(first.list().map((provider) => provider.name), ['one'])
  assert.deepEqual(second.list().map((provider) => provider.name), ['two'])
  assert.throws(() => first.get('two'), ProviderNotFoundError)
})
