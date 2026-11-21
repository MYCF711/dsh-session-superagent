// 2026-11-20 真机回归：batchLimit 截断 + ack 推全局水位，会把「另有 N 条」永久吞掉。
//
// 现场（iJetLi/dsh-providers-hub）：一轮 5 条变化，这条守 batchLimit=2 ⇒ 正文只列
// #134 / #133，#131 只出现在「（另有 3 条：#132 #131 #130）」那一行。会话处理完 #133
// 后 watch_ack 把全局 cursor 推到当下（17:30），而 #131 的 updated_at 是 13:09、
// 又不在 seen / pending 里 ⇒ 之后每一轮 partitionItems 都拿 cursor 当基线，
// PR #131 再也没被唤醒、也没打标签。
//
// 两条腿都必须有：
//   1. 唤醒成功时 pending 记**全部 fresh**（含只出现在「另有」里的条目）——
//      它们是「处理完这批再看」的承诺，不能只靠「本轮水位不前移」这一根保险；
//   2. watch_ack 只在 pending 清空后才推全局 cursor —— 队列里还有活时，
//      水位就是全仓库共享的 floor，推过去等于把没列的条目一起判成旧闻。
import assert from 'node:assert/strict'
import { tempDir } from './fixtures/tmpdir.mjs'
import test from 'node:test'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-unlisted-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'

const { __test, apply } = await import('../lib/index.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const parsed = (items) => ({ status: 200, etag: null, body: JSON.stringify(items) })
const issue = (n, updatedAt) => ({
  number: n,
  title: 't' + n,
  state: 'open',
  user: { login: 'u' },
  labels: [],
  assignees: [],
  comments: 0,
  html_url: 'https://github.com/o/r/issues/' + n,
  updated_at: updatedAt,
})

function makeCtx(tools) {
  const agent = { status: 'idle', followup: () => {} }
  return {
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: () => () => {} },
    agents: { currentInitiator: () => ({ id: 's1' }), get: () => agent },
    get: () => null,
    effect: (fn) => fn(),
    inject: () => {},
  }
}

/** pollWithItems 会回读盘上的条目（暂停/删除判定），所以每条守都要先落盘。 */
function persist(entry) {
  const state = __test.readState()
  state.watchers = state.watchers || {}
  state.watchers[entry.id] = entry
  __test.writeState(state)
  return entry
}

function makeEntry(id, repo, over = {}) {
  return persist({
    id,
    repo,
    provider: 'github',
    sessionId: 's1',
    intervalSec: 60,
    enabled: true,
    observe: false,
    seen: {},
    lastReported: {},
    cursor: '2026-11-19T22:00:00.000Z',
    batchLimit: 2,
    filters: { labels: [], ignoreLabels: [], skipBots: false, skipDrafts: false, skipClosed: true },
    priority: { reopened: true, comments: true, labels: true },
    ...over,
  })
}

function captureWake(sent) {
  return (ctx, sessionId, text, onSettled) => {
    sent.push(text)
    if (onSettled) onSettled({ ok: true })
    return { ok: true }
  }
}

const ITEMS = () => [
  issue(134, '2026-11-20T14:31:52.000Z'),
  issue(133, '2026-11-20T13:22:37.000Z'),
  issue(132, '2026-11-20T13:22:12.000Z'),
  issue(131, '2026-11-20T13:09:06.000Z'),
  issue(130, '2026-11-20T09:06:59.000Z'),
]

test('v2 批次里没列出的条目不靠 pending，也能在 ack 后继续交付', async () => {
  const sent = []
  const tools = []
  const ctx = makeCtx(tools)
  apply(ctx)
  const entry = makeEntry('o/r#s1', 'o/r')

  await __test.pollWithItems(ctx, entry, 60000, parsed(ITEMS()), null, { wake: captureWake(sent) })
  await wait(60)

  assert.equal(sent.length, 1, '应真的发出去一次')
  assert.match(sent[0], /另有 3 条：#132 #131 #130/, '现场形态：#131 只在「另有」一行里')
  assert.deepEqual(Object.keys(entry.obs || {}).sort(), ['issue:133', 'issue:134'], '只有正文条目提交 delivered')
  assert.equal(entry.obs['issue:131'], undefined, '未列出的 #131 不得提前交付')

  // 会话处理正文里的 #133：打标签 + ack。
  const ack = tools.find((tool) => tool.name === 'watch_ack')
  assert.ok(ack, 'watch_ack 必须注册')
  const acked = JSON.parse(await ack.execute({ repo: 'o/r', numbers: 133, format: 'json' }))
  assert.equal(acked.ok, true, JSON.stringify(acked))

  const afterAck = __test.readState().watchers['o/r#s1']
  assert.equal(
    afterAck.cursor,
    '2026-11-19T22:00:00.000Z',
    '队列里还有 4 条没处理，cursor 不许推到 ack 时刻（否则 #131 的 13:09 永远落在水位之下）',
  )

  // 下一轮：GitHub 上什么都没再更新，被截断的 #131 必须回到正文。
  await __test.pollWithItems(ctx, afterAck, 60000, parsed(ITEMS()), null, { wake: captureWake(sent) })
  await wait(60)

  assert.equal(sent.length, 2, '第二轮必须再唤醒一次')
  assert.match(sent[1], /#131 \[open\]/, '上一轮只出现在「另有」里的 #131 必须重新进入正文行，否则就是永久静默')
})

test('原生 v2：obs 只提交正文条目，下一轮未列条目继续交付', async () => {
  const sent = []
  const tools = []
  const ctx = makeCtx(tools)
  apply(ctx)
  const entry = makeEntry('o/native#s1', 'o/native', { watermarkVersion: 2, round: 0, obs: {}, pending: {} })

  await __test.pollWithItems(ctx, entry, 60000, parsed(ITEMS()), null, { wake: captureWake(sent) })
  await wait(60)
  assert.equal(entry.watermarkVersion, 2)
  assert.equal(entry.obs['issue:134'].delivered.cursor.startsWith('h:'), true)
  assert.equal(entry.obs['issue:131'], undefined, '未列条目不得提前写 delivered')

  await __test.pollWithItems(ctx, entry, 60000, parsed(ITEMS()), null, { wake: captureWake(sent) })
  await wait(60)
  assert.equal(sent.length, 2)
  assert.match(sent[1], /#131 \[open\]/)
  assert.ok(entry.obs['issue:131'].delivered, '第二轮后 #131 才提交 delivered')
})

test('ack 不碰全局水位：队列为空也不推（防止把同页没列出的条目一起判成旧闻）', async () => {
  const tools = []
  const ctx = makeCtx(tools)
  apply(ctx)
  makeEntry('o/clean#s1', 'o/clean', { pending: {} })

  const ack = tools.find((tool) => tool.name === 'watch_ack')
  const out = JSON.parse(await ack.execute({ repo: 'o/clean', numbers: 9, format: 'json' }))
  assert.equal(out.ok, true, JSON.stringify(out))

  const live = __test.readState().watchers['o/clean#s1']
  assert.equal(
    live.cursor,
    '2026-11-19T22:00:00.000Z',
    'ack 是单条动作，seen 才是它该写的水位；全局 cursor 由轮询在「整批都列出去」时推进',
  )
  assert.equal(live.seen['9'], out.at, 'seen[9] 必须前进到本次 ack 时间（防自唤醒靠它）')
})

test('唤醒被每小时上限挡住（pending 为空）时，ack 也不许把整页吞掉', async () => {
  const tools = []
  const ctx = makeCtx(tools)
  apply(ctx)
  // 上一轮被 cap-watcher 挡下：fresh 一条都没消费，pending 因此是空的。
  makeEntry('o/capped#s1', 'o/capped', { pending: {}, maxWakesPerHour: 1, wakeTimes: [Date.now()] })

  const ack = tools.find((tool) => tool.name === 'watch_ack')
  const out = JSON.parse(await ack.execute({ repo: 'o/capped', numbers: 9, format: 'json' }))
  assert.equal(out.ok, true, JSON.stringify(out))

  const live = __test.readState().watchers['o/capped#s1']
  assert.equal(live.cursor, '2026-11-19T22:00:00.000Z', '没有待处理条目 ≠ 这一页已经消费完')
})

test('冷却期吸收掉的更新只写 seen，不许推进全局 cursor（否则同页更旧的条目被跳过）', async () => {
  const sent = []
  const tools = []
  const ctx = makeCtx(tools)
  apply(ctx)
  const entry = makeEntry('o/absorb#s1', 'o/absorb', {
    cursor: '2026-11-20T11:00:00.000Z',
    batchLimit: 1,
  })

  // 轮 1：A 和 X 都是新的，但 batchLimit=1 只列 A —— listed<fresh，cursor 不动。
  const r1 = [issue(1, '2026-11-20T12:00:00.000Z'), issue(3, '2026-11-20T11:50:00.000Z')]
  await __test.pollWithItems(ctx, entry, 60000, parsed(r1), null, { wake: captureWake(sent) })
  await wait(60)
  assert.equal(sent.length, 1, '轮 1 只叫醒 A')
  assert.equal(entry.cursor, '2026-11-20T11:00:00.000Z', 'listed<fresh 时 cursor 必须不动')

  // 轮 2：A 在 180 秒冷却窗口内又更新 → absorbed；Y 抢走唯一名额，X 留在溢出。
  const r2 = [
    issue(1, '2026-11-20T12:05:00.000Z'),
    issue(2, '2026-11-20T12:02:00.000Z'),
    issue(3, '2026-11-20T11:50:00.000Z'),
  ]
  await __test.pollWithItems(ctx, entry, 60000, parsed(r2), null, { wake: captureWake(sent) })
  await wait(60)
  assert.equal(sent.length, 2, '轮 2 叫醒 Y')
  assert.equal(
    entry.cursor,
    '2026-11-20T11:00:00.000Z',
    '被吸收的是 A 自己的更新：只许写 seen[A]，不许把 cursor 抬到 12:05 —— 那会把更旧的 X 判成旧闻',
  )

  // 轮 3：A/Y 都被 seen 挡住，X 必须重新成为 fresh（修复前会被 absorbed 的 cursor 吞掉）。
  await __test.pollWithItems(ctx, entry, 60000, parsed(r2), null, { wake: captureWake(sent) })
  await wait(60)
  assert.equal(sent.length, 3, '轮 3 必须叫醒 X')
  assert.match(sent[2], /#3 \[open\]/, '同页更旧的 X 不能被 absorbed 推进的 cursor 吞掉')
})