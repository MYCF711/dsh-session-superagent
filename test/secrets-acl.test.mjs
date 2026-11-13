// 凭证文件权限收紧：Windows 上 chmod 无效（Node 文档 fs.chmod Caveats 写明
// owner/group/others 的区分根本没实现），所以实现里补了 icacls；POSIX 上走 chmod 0600。
//
// 这条用例两个平台都要跑，理由不是「用例计数」而是**跨平台暴露真实的权限路径**：
// 2026-11-13 CI（Ubuntu / Node 24，1000/1001）就是这条第一次真正跑 POSIX 实现，当场发现
// `hardenSecretsFile` 里的 `chmodSync` 根本没从 `node:fs` import（ReferenceError 被实现
// catch 成 'failed'，于是 `assert.notEqual(mode, 'failed')` 红）。
// 为了让 POSIX 路径在 Windows 本地也有覆盖，Windows 分支会在**同一个 test 内**临时把
// `process.platform` 切成 'linux'，再调用一次真实实现。
import { execFileSync } from 'node:child_process'
import { tempDir } from './fixtures/tmpdir.mjs'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

/** 取 file 的权限位（八进制写法，和断言里的 0o600 同一口径）；取不到就把原因带回来，绝不在诊断里再抛一次。 */
function modeOf(file) {
  try {
    return '0o' + (statSync(file).mode & 0o777).toString(8).padStart(3, '0')
  } catch (error) {
    return '(stat 失败：' + String((error && error.message) || error) + ')'
  }
}

/**
 * 临时把 `process.platform` 换成 target 跑 fn，**无论如何**把原描述符还回去。
 * 不能写成 `delete process.platform`：它是 process 自带的 own accessor，删掉之后
 * `process.platform` 会变成 undefined（本机实测），后续所有用例都会跟着坏。
 */
function withPlatform(target, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: target, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

test('凭证文件权限收紧到「只有当前用户」', async () => {
  const { __test } = await import('../lib/index.js')
  const dir = tempDir('zhuli-acl-')
  const file = join(dir, 'secrets.json')
  let hardened
  let simulated = null
  try {
    writeFileSync(file, '{"token":"x"}')
    hardened = __test.hardenSecretsFile(file)
    if (process.platform === 'win32') {
      assert.equal(hardened, 'win32-acl', 'Windows 应当走 icacls 路径')
      // GBK 输出：用 iconv 太麻烦，这里只做字节层面的判断
      const out = execFileSync('icacls', [file], { encoding: 'buffer' }).toString('latin1')
      assert.ok(!/Users/i.test(out) || !/BUILTIN/.test(out.replace(/Administrators/gi, '')), '不应保留 Users 组：' + out.slice(0, 200))
      assert.match(out, /\(F\)/, '当前用户必须有完全控制')

      // 同一个 test 内模拟 POSIX：Windows 本地也要真的执行 chmod 那条实现。
      // 返回值必须精确是 'posix-0600' —— 少了 import 的 chmodSync 会抛 ReferenceError 并被
      // 实现 catch 成 'failed'，这条断言钉的就是那个回归。
      simulated = withPlatform('linux', () => __test.hardenSecretsFile(file))
      assert.equal(simulated, 'posix-0600', '模拟 POSIX：应当走 chmod 0600 路径')
      // 精确的 mode 断言只放在真正的 POSIX 分支（下面 else）：Windows 的 chmod 只切只读位
      // （Node 文档 fs.chmod Caveats），本机实测 chmod(0o600) 之后 statSync().mode & 0o777
      // 仍是 0o666 —— 在这里断言 0o600 才是伪造一个平台给不出的数字。
    } else {
      assert.equal(hardened, 'posix-0600', 'POSIX 应当走 chmod 0600 路径')
      assert.equal(statSync(file).mode & 0o777, 0o600, '应当只有 owner 可读写')
    }
  } catch (error) {
    // 失败时只补诊断，不改判据：把平台 / 返回值 / 实际 mode / 错误原样打出来，再把原错误原样抛回去。
    // 值不加引号：`键 : 值` 形状会被宿主的 keyed-value 脱敏替换掉，CI 日志里就只剩「有个值」。
    console.error([
      '',
      '[secrets-acl 诊断] 用例失败，原样信息如下（不 skip、不放宽断言）',
      '  platform            : ' + process.platform,
      '  harden() 返回值      : ' + (hardened === undefined ? '(未取到：writeFileSync 或 import 先失败)' : String(hardened)),
      '  模拟 POSIX 返回值    : ' + (simulated === null ? '(未执行：真实平台不是 win32 或前面先失败)' : String(simulated)),
      '  statSync(file).mode : ' + modeOf(file),
      '  error.message       : ' + String((error && error.message) || error),
      '  error.stack         : ' + String((error && error.stack) || error),
      '',
    ].join('\n'))
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
