// Windows 用 icacls 收紧 ACL；POSIX 用 chmod 0600。Windows 分支也模拟 POSIX，覆盖真实实现。
import { execFileSync } from 'node:child_process'
import { tempDir } from './fixtures/tmpdir.mjs'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const ORDINARY_GROUP_SIDS = ['S-1-5-11', 'S-1-5-32-545', 'S-1-1-0']

function withPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

function currentWindowsSid() {
  const systemRoot = process.env.SystemRoot || process.env.windir
  assert.ok(systemRoot, 'Windows 必须提供 SystemRoot')
  // 不用 Git Bash 的 /usr/bin/whoami；SID 是 ASCII，不受本机代码页影响。
  const whoami = join(systemRoot, 'System32', 'whoami.exe')
  const out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'buffer', timeout: 15000 }).toString('latin1')
  const sid = out.match(/\bS-\d+(?:-\d+)+\b/i)?.[0]
  assert.ok(sid, 'whoami 必须返回当前用户 SID：' + out)
  return sid
}

function aclEvidence(file) {
  const icacls = execFileSync('icacls', [file], { encoding: 'buffer', timeout: 15000 }).toString('latin1')
  // icacls 回读用于真实命令证据；结构化 ACE 不依赖英文组名、SDDL 别名或显示语言。
  const aces = JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'ConvertTo-Json -Compress -InputObject @((Get-Acl -LiteralPath $env:DSH_SUPERAGENT_ACL_TEST_FILE).Access | ForEach-Object { [pscustomobject]@{ Sid = ($_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])).Value; AccessControlType = $_.AccessControlType.ToString(); FileSystemRights = $_.FileSystemRights.ToString() } })',
  ], {
    encoding: 'latin1', timeout: 15000,
    env: { ...process.env, DSH_SUPERAGENT_ACL_TEST_FILE: file },
  }).trim())
  return { icacls, aces }
}

function assertOnlyCurrentUser(file) {
  const userSid = currentWindowsSid()
  const { icacls, aces } = aclEvidence(file)
  assert.ok(aces.some((ace) => ace.AccessControlType === 'Allow' && ace.FileSystemRights === 'FullControl' && ace.Sid === userSid), '当前用户必须有显式 FullControl：' + icacls + '\n' + JSON.stringify(aces))
  for (const sid of ORDINARY_GROUP_SIDS) {
    assert.ok(!aces.some((ace) => ace.Sid === sid), `不应残留 ${sid} 的 grant/deny：${icacls}\n${JSON.stringify(aces)}`)
  }
}

function seedOrdinaryGroupAces(file) {
  const userSid = currentWindowsSid()
  execFileSync('icacls', [
    file, '/inheritance:r', '/grant:r', `*${userSid}:F`,
    '*S-1-5-11:(M)', '*S-1-5-32-545:(RX)', '*S-1-1-0:(RX)',
  ], { stdio: 'ignore', timeout: 15000 })
  execFileSync('icacls', [
    file, '/deny', '*S-1-5-11:(W)', '*S-1-5-32-545:(W)', '*S-1-1-0:(W)',
  ], { stdio: 'ignore', timeout: 15000 })

  const { icacls, aces } = aclEvidence(file)
  for (const sid of ORDINARY_GROUP_SIDS) {
    assert.ok(aces.some((ace) => ace.AccessControlType === 'Allow' && ace.Sid === sid), `反向用例必须预置 ${sid} grant：${icacls}`)
    assert.ok(aces.some((ace) => ace.AccessControlType === 'Deny' && ace.Sid === sid), `反向用例必须预置 ${sid} deny：${icacls}`)
  }
}

test('凭证文件权限收紧到「只有当前用户」', async () => {
  const { __test } = await import('../lib/index.js')
  const dir = tempDir('zhuli-acl-')
  const file = join(dir, 'secrets.json')
  try {
    writeFileSync(file, '{"token":"x"}')
    const mode = __test.hardenSecretsFile(file)
    if (process.platform === 'win32') {
      assert.equal(mode, 'win32-acl', 'Windows 应当走 icacls 路径')
      assertOnlyCurrentUser(file)

      const simulated = withPlatform('linux', () => __test.hardenSecretsFile(file))
      assert.equal(simulated, 'posix-0600', '模拟 POSIX 应当走 chmod 0600 路径')
      assert.equal(process.platform, 'win32', '必须恢复 process.platform 描述符')
    } else {
      assert.equal(mode, 'posix-0600', 'POSIX 应当走 chmod 0600 路径')
      assert.equal(statSync(file).mode & 0o777, 0o600, '应当只有 owner 可读写')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('预置普通用户组 grant/deny 后也全部移除', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows ACL 专用')
    return
  }
  const { __test } = await import('../lib/index.js')
  const dir = tempDir('zhuli-acl-seeded-')
  const file = join(dir, 'secrets.json')
  try {
    writeFileSync(file, '{"token":"x"}')
    seedOrdinaryGroupAces(file)
    assert.equal(__test.hardenSecretsFile(file), 'win32-acl')
    assertOnlyCurrentUser(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
