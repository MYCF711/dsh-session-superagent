import assert from 'node:assert/strict'
import test from 'node:test'
import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-github-tool-write-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
assertTempStateDir('github-tool-write.test.mjs')

const { __test } = await import('../lib/index.js?github-tool-write=' + Date.now())

test('issue #63：github 写方法必须同时声明 --input - 并传入原始 JSON body', () => {
  assert.equal(typeof __test.githubApiRequest, 'function', '导出真实请求构造，避免离线 gh 不看 stdin 造成假绿')
  const body = '{"text":"**probe**","nested":{"ok":true}}'
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const request = __test.githubApiRequest(method, 'markdown', body)
    assert.deepEqual(request.argv, ['api', '-X', method, 'markdown', '--header', 'Accept: application/vnd.github+json', '--input', '-'], method)
    assert.equal(request.input, body, method + ' 的 stdin 必须是未经改写的原始 body')
  }
  for (const method of ['GET', 'HEAD']) {
    const request = __test.githubApiRequest(method, 'user', body)
    assert.equal(request.argv.includes('--input'), false, method + ' 不从 stdin 构造写请求')
    assert.equal(request.input, undefined)
  }
  const emptyDelete = __test.githubApiRequest('DELETE', 'repos/o/r/labels/probe', '')
  assert.equal(emptyDelete.argv.includes('--input'), false, '无 body 的 DELETE 不附加空 stdin')
  assert.equal(emptyDelete.input, undefined)
})
