# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页，再按 [AGENTS.md](./AGENTS.md) 的「先定位你在哪一步」读对应文档。
> **每次干完活必须更新「二、当前状态」与「三、下一步」** —— 这页不是历史，是交接单。

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-session-superagent` |
| npm 包名 | `dsh-session-superagent` |
| 当前候选版本 | `1.0.0`（工作树候选；**尚未推 tag / Release / npm**） |
| 最近已发布版本 | `0.11.0`；本轮不把候选版本写成已发布 |
| 形态 | DSH 插件：12 个工具 + `cordis.patch.yml` + 客户端面板与状态栏圆环 |
| 目标宿主 | DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`；Node ≥ 22.19；需已登录 `gh` CLI |

## 二、当前状态（2026-11-21）

```text
基线        origin/main@a4742da（0.11.0）
工作树      task/watermark-v2-rooms；前六房各有独立提交，真实接线/终审修复随后一并提交
候选版本    1.0.0；删除旧水位路径与 12 个旧 named exports，属于 Breaking
状态模型    obs 是唯一新鲜度事实源；seen/cursor/pending 只作迁移输入或派生投影
```

| 资产 / 验证 | 当前结果 |
|---|---|
| 全量单测 | **1233/1233，exit 0** |
| 隔离 profile preflight | **44 项，exit 0**；冒烟 / 贡献归属（无 PR 上下文）/ 维护一致性（PR 阶段）为规范 SKIP |
| 房间依赖 | **6/6 PASS**；`scripts/check-rooms.mjs` 已接入 preflight |
| 另起实例 | 隔离安装副本 `1.0.0`、12 个工具、创建/读取 watcher、`watermarkVersion=2` 均通过 |
| 运行库净减 | **8746 → 8692 行（-54）**；dependencies / devDependencies 均未增加 |
| 决策性能 | 100 条目 × 1000 次：v1 中位 0.0193ms，v2 中位 0.0040ms |
| 真实 GitHub ack | 临时标签写入 + 写后重读通过，随后已清理 |
| 真实 Gitee ack | **未验**：无已有 PR，多个仓库创建 issue 持续 404（`project or enterprise`） |
| UI | 本轮未改 UI 结构；既有 `ui-audit` 由 preflight 复验通过 |

关键证据位于 `dsh-sa-artifacts/`：`watermark-v2-final-test.log`、`watermark-v2-final-preflight.log`、`verify-isolated-instance.mjs`、`watermark-v2-independent-audit.md`。

### 本轮关闭的问题

- 未列条目不靠全局 cursor / pending 也会被后续批次交付；ack 只写本行。
- PR 评论 11/12 分两轮交付；legacy `seenComments` 不吞 11、不回退、不夹带旧评论。
- `onlyNewComments` 使用 discussion / review 分通道计数指纹，同秒新增与 GraphQL/REST 切换均不会误判。
- `watch_ack` 通过 provider 写后重读并提交 post-cursor；Gitee 归一化保留 body。
- 跨进程单写者锁覆盖 read-merge-rename；Windows `EPERM` 有界重试，`writeError` 不伪装成功。
- 同 round 合并不读时钟，行 cursor 与 winning event 一致，`delivered` 与 `undelivered` 不共存。
- 投影区分「尚未拉取」（计数 `null`）与「明确 0 条」。

### 未验证 / 边界

- 真实 Gitee ack 写操作（上表原因）；不能从 fake / 本地归一化推断为通过。
- 真实 DSH 宿主重载后的长期运行、读屏 / 触摸 / IME；本轮没有重启宿主。
- 跨主机 NFS/SMB 锁语义、不经过本锁的外部写者、连续 24 小时运行。
- Node 22/24 矩阵以 PR CI 为准，本机实测 Node 24.20。

## 三、下一步

1. 固化当前完整 diff，确保所有 fixture 一并提交；不能只推前六个房间提交。
2. 独立审查当前快照后，推 `task/watermark-v2-rooms` 并开 PR；双 Node CI 通过才合入。
3. 合并前按 [UPDATING.md](./UPDATING.md) 处理 `v1.0.0` tag，避免 main「先合并后推 tag」的维护一致性竞态。
4. Release 与 npm 是独立发布动作；未执行前一律称 `1.0.0` 为候选版本。
5. 有可写 Gitee 测试 issue/PR 后，补真实 ack + 写后重读并清理，再关闭该未验项。
