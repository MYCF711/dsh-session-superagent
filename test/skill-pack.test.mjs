import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  GITHUB_SKILL_NAME,
  GITHUB_SKILL_PATH,
  SkillPackError,
  loadSkillPack,
  parseSkillPack,
  skillToolReferences,
  validateGithubSkillPack,
  validateSkillPack,
} from '../lib/rooms/skill-pack.js'

function sourceWith(content, name = GITHUB_SKILL_NAME) {
  return `---\nname: ${name}\ndescription: Test GitHub operations.\n---\n\n${content}`
}

function registeredToolNames() {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/ctx\.tools\.register\(defineTool\(\{\s*name:\s*'([^']+)'/g)) names.add(match[1])
  return names
}

test('skill-pack：严格解析 frontmatter，CRLF 归一且返回冻结对象', () => {
  const pack = parseSkillPack(sourceWith('Use `github` for reads.\nNext line.\n').replaceAll('\n', '\r\n'))
  assert.equal(pack.name, GITHUB_SKILL_NAME)
  assert.equal(pack.description, 'Test GitHub operations.')
  assert.equal(pack.content.includes('\r'), false)
  assert.match(pack.content, /Next line/)
  assert.equal(Object.isFrozen(pack), true)
})

test('skill-pack：空文件、形状漂移、非法名称与空正文都明确失败', () => {
  assert.throws(() => parseSkillPack('  '), (error) => error.code === 'SKILL_EMPTY')
  assert.throws(() => parseSkillPack('name: github'), (error) => error.code === 'SKILL_FRONTMATTER_INVALID')
  assert.throws(() => parseSkillPack(sourceWith('body', 'Bad_Name')), (error) => error.code === 'SKILL_NAME_INVALID')
  assert.throws(() => parseSkillPack(sourceWith('   \n')), (error) => error.code === 'SKILL_CONTENT_EMPTY')
  const extraField = sourceWith('body').replace('description:', 'owner: nobody\ndescription:')
  assert.throws(() => parseSkillPack(extraField), (error) => error.code === 'SKILL_FRONTMATTER_INVALID')
})

test('skill-pack：磁盘读取通过显式端口注入，读取异常保留 cause', () => {
  const pack = loadSkillPack('virtual/SKILL.md', (path, encoding) => {
    assert.equal(path, 'virtual/SKILL.md')
    assert.equal(encoding, 'utf8')
    return sourceWith('Use `repo_here`.')
  })
  assert.equal(pack.path, 'virtual/SKILL.md')
  assert.throws(() => loadSkillPack('missing/SKILL.md', () => { throw new Error('ENOENT') }), (error) => {
    assert.ok(error instanceof SkillPackError)
    assert.equal(error.code, 'SKILL_READ_FAILED')
    assert.equal(error.cause.message, 'ENOENT')
    return true
  })
  assert.throws(() => loadSkillPack('x'), /requires readFile/)
})

test('skill-pack：工具引用去重并校验 available tools，不存在的名字 fail loud', () => {
  const pack = parseSkillPack(sourceWith('Use `github`, then `watch_ack`; `github` may be repeated.'))
  assert.deepEqual(skillToolReferences(pack), ['github', 'watch_ack'])
  const result = validateSkillPack(pack, new Set(['github', 'watch_ack']), { requiredTools: ['watch_ack'] })
  assert.deepEqual(result, { ok: true, name: GITHUB_SKILL_NAME, tools: ['github', 'watch_ack'] })

  const bad = parseSkillPack(sourceWith('Use `watch_not_real`.'))
  assert.throws(() => validateSkillPack(bad, ['github']), (error) => {
    assert.equal(error.code, 'SKILL_TOOL_UNKNOWN')
    assert.deepEqual(error.missingTools, ['watch_not_real'])
    return true
  })
  assert.throws(() => validateSkillPack(pack, ['github', 'watch_ack'], { requiredTools: ['watch_trace'] }), (error) => {
    assert.equal(error.code, 'SKILL_TOOL_UNREFERENCED')
    assert.deepEqual(error.requiredTools, ['watch_trace'])
    return true
  })
})

test('GitHub skill：真实随包文本只引用 lib/index.js 实际注册的工具', () => {
  const available = registeredToolNames()
  for (const name of ['github', 'repo_here', 'watch_ack', 'watch_pr_ack', 'watch_status', 'watch_trace']) {
    assert.equal(available.has(name), true, `test probe must discover registered tool ${name}`)
  }
  const pack = loadSkillPack(GITHUB_SKILL_PATH, (path, encoding) => {
    return readFileSync(new URL('../' + path, import.meta.url), encoding)
  })
  const checked = validateGithubSkillPack(pack, available)
  assert.equal(checked.ok, true)
  assert.equal(pack.name, GITHUB_SKILL_NAME)
  assert.deepEqual([...checked.tools].sort(), ['github', 'repo_here', 'watch_ack', 'watch_pr_ack', 'watch_status', 'watch_trace'].sort())
})

test('GitHub skill：名称契约不能被其他 skill 混用', () => {
  const pack = parseSkillPack(sourceWith('Use `github`.'))
  assert.throws(() => validateGithubSkillPack({ ...pack, name: 'other-skill' }, ['github']), (error) => {
    assert.equal(error.code, 'SKILL_NAME_MISMATCH')
    return true
  })
})
