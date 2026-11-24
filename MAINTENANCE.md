# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页，再按 [AGENTS.md](./AGENTS.md) 的「先定位你在哪一步」读对应文档。
> **每次干完活必须更新「二、当前状态」与「三、下一步」** —— 这页不是历史，是交接单。

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | 独立实验仓 `MYCF711/dsh-session-superagent-refactor`（上游 `MYCF711/dsh-session-superagent`） |
| npm 包名 | `dsh-session-superagent` |
| 当前候选版本 | `2.0.0`（工作树候选；**尚未推 tag / Release / npm**） |
| 最近已发布版本 | 上游 `0.11.0`；本轮候选不写成已发布 |
| 形态 | DSH 插件：12 个工具 + 16 条路由 + 客户端面板与状态栏圆环 |
| 目标宿主 | DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`；Node ≥ 22.19；需已登录 `gh` CLI |

## 二、当前状态（2026-11-23）

```text
基线        上游 main@95b5a72（水位 v2 / 1.0.0）
工作树      session-superagent-ui（基于 c80353f）；团队实现会话级导航，未推送，主仓库不改
候选版本    2.0.0；20 个最小房间 + modular-runtime + modular-outbox-host
默认行为    旧 watcher 仍 inline；只有显式 executionMode=worker 才创建独立 worker Session
当前目标    左侧全局中枢 + 会话右栏 + 服务端 session scope；旧中栏已删除
统一契约    docs/设计-会话级导航与运行时.md（结论、要求、目标、验收与 10 条踩坑）
团队任务    task-16 后端 scope；task-17 官方 slot；task-18 共享 UI；task-19 集成；task-20/21 双盲
```

| 资产 / 验证 | 当前结果 |
|---|---|
| 全量单测 | **1420/1420，exit 0**；隔离 preflight 41 PASS + 3 SKIP。新增 Cordis 未 inject admission 可选服务代理回归，修复重启后 watcher 首轮报错 |
| 房间边界 | **20/20 PASS**；UI audit **11/11** |
| Outbox | 同进程单飞、跨进程租约、热重载共享 flush、不同 Ticket 排队、attempts 栅栏均有回归 |
| 生产接线 | worker/inline、bot/系统事件、ack 操作 ID、watcher 世代、marker 分页、执行模式切换已定向复验 |
| 草稿 | revision 乐观锁 + 旧值 409；前端保留另一标签页未保存文本 |
| 隔离 preflight / 实例 | **exit 0：41 PASS + 3 个预期 SKIP**；`session-ui-review-preflight.log`。profile 缺失/断链/陈旧均 0；2.0.0 headless 实例 `watch_start`、重挂 interval、12 工具通过 |
| CI 预验 / PR CI | Node **22.23.5** 按 CI 命令跑 fast preflight：**1415/1415、39 项检查 exit 0**，UI/docs 通过；`session-ui-node22-preflight.log`。Node **24.20.0** 已跑完整 preflight。GitHub PR [#2](https://github.com/MYCF711/dsh-session-superagent-refactor/pull/2) 初始 head `d356156` 的 Node 22/24 CI 均 pass（run `45170097802`）；最新 head 以 PR checks 为准 |
| 双盲 Debug | task-20 核心重试：25 个真实 HTTP、10 类跨会话写 403、状态哈希不变、公开回归 19/19，**0 findings**；`session-ui-blind-core-retry/REPORT.md`。task-21 UI 原四项复核全部 CLOSED，独立 18/18；`session-ui-blind-ui/REPORT-RECHECK.md` |
| UI | 新导航真实 Chromium **18/18，exit 0**；旧中栏缺席、会话隔离、全局新建、头部 pressed/toggle/Tooltip、键盘、双主题与 700px 完整矩阵通过；`session-ui-review-final-v3/`。**用户已确认整版 UI；实验仓 PR [#2](https://github.com/MYCF711/dsh-session-superagent-refactor/pull/2)** |
| headless | 无 `webServer` 实例 `watch_start`、重新 import/apply、interval 恢复通过；单守异常不连累好守，`lastError` 落盘有回归 |
| 双盲修正 | 正常退避/时段外不误报；长期 never、enabled 兼容、optional 缺 stable、异常筛选/Orbit/按仓库错误点均有反向用例；双主题预览含错误点 |

### 本轮已修复的关键边界

- 活跃 `leaseUntil` 不被其他进程 recover；过期租约才允许接管，marker/messageId 负责崩溃后的远端查重。
- 同 ctx/热重载共享 host；同 scope 共用回执，不同 scope 排队执行，A 的回执不能冒充 B。
- bot 与无评论系统事件不 resume ended Ticket；ack ID 包含 kind/comment/note/label 与 watcher 世代。
- inline resume 缺会话 409；busy queued 不回滚；最终失败只回滚同 assignment 世代。
- 执行模式切换结束旧 Assignment 并解除/重建订阅；worker→inline 必须先停旧 worker。
- 成功写盘清 `lastWriteError`；inline 不需要 `sessionController`，不再误报 paused。
- marker 查重分页，截断显式失败；不能因一页没查到而重复评论。

### 未验证 / 边界

- **目标阻塞已解除（2026-11-23）**：用户已在独立交互实例 <http://127.0.0.1:8878/> 完成整版 UI 确认，并明确允许推实验仓分支。此前目标轮 3/4/5 与 6/7/8 的确认门已解除；主仓库仍不改，tag/Release/npm 未授权。

- 新导航已有最终截图、真实 Chromium fixture 点击链路和用户整版确认；未验真实 DSH WebView 的读屏/触摸/IME。
- 当前 task-20/21 两组双盲均已签收；证据范围是独立 HTTP、真实 Chromium fixture 与官方源码对照，不扩展为真实宿主长期运行通过。
- 真实 DSH 宿主重载后的长期运行、读屏/触摸/IME；本轮不重启宿主。
- 真实 Gitee 写操作仍未验；fake/本地归一化不能替代真实仓库回读。
- 跨主机 NFS/SMB 锁语义、不经过本锁的外部写者、连续 24 小时运行未验。

## 三、下一步

1. 按 task-16/17 → task-18 → task-19 → task-20/21 推进；写作用域不重叠，Lead 负责最终 diff 与集成。
2. 全量、隔离实例、双主题、真实交互和两组双盲未完成不得宣称完成；最终 UI 确认前不推送，不发布 tag / Release / npm。
3. 有可写 Gitee 测试 issue/PR 后，补真实 ack + 写后重读并清理，再关闭该未验项。
