# Windows 上 `chmod 0600` 保护不了 token

## 出处
- Node.js 文档 `fs.chmod` 的 Caveats：*"on Windows only the write permission can be changed,
  and the distinction among the permissions of group, owner, or others is not implemented."*
  <https://nodejs.org/api/fs.html>
- `fs.access` 同页也提醒：**它不会检查 ACL**，所以"能访问"不代表"权限没问题"。

## 它怎么做的
Node 在 Windows 上把 `mode` 映射到只读属性，`0o600` 里的 owner/group/others 语义丢掉了。
真要做，只能走 ACL：用当前用户 SID 授予 `F`，并按固定 SID 删除 Authenticated Users（`S-1-5-11`）、BUILTIN Users（`S-1-5-32-545`）与 Everyone（`S-1-1-0`）的 grant/deny。`/grant:r` 只替换指定主体的 ACE，不能单独依赖它清理其他显式 ACE。

## 我们能怎么用
我们把 GitHub token 写在 `<state>/secrets.json`，一直用 `{ mode: 0o600 }` 写 ——
在 Windows 上**约等于没有保护**。

改法：写完立刻
- POSIX：`chmod 0600`；
- Windows：`icacls <file> /inheritance:r /grant:r *<当前用户SID>:F /remove:g <三组SID> /remove:d <三组SID>`（断开继承，并清掉普通组显式 ACE；SID 前的 `*` 是 icacls 的数字 SID 语法）。
结果记进 `secretsHardened`，`/diagnose` 里显示「凭证保护: win32-acl / posix-0600 / failed」。

## 实测（本机）
```
收紧前： NT AUTHORITY\SYSTEM:(I)(F)
         BUILTIN\Administrators:(I)(F)
         OWNER RIGHTS:(I)(F)
收紧后： <用户>:(F)
```
继承来的 SYSTEM / Administrators 被断开，只剩本人。反向实测先给三组都预置 grant 与 deny，修复后同样只剩本人 `(F)`。

## 是否已落地
✅ 初版 0.8.62；当前分支补齐显式组 ACE 清理。用例 `test/secrets-acl.test.mjs`：
调 `hardenSecretsFile` 后用真实 `icacls` 回读，并通过 `Get-Acl.Access` 将主体转换成 SID，断言当前用户有 `FullControl`、三组 grant/deny 均为零；另有一条先预置三组 grant/deny 的反向用例。POSIX 分支验证 `chmod 0600`。

## 还没做的
- 没做**轮换**：token 泄漏后需要人工去面板换；将来可以加"上次使用时间 + 一键轮换"；
- 没验证断开继承对备份软件的副作用（个人工具，先按最小可见面处理）。
