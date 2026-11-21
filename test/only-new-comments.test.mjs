import assert from 'node:assert/strict'
import test from 'node:test'

import { tempDir, assertTempStateDir } from './fixtures/tmpdir.mjs'
import { mergeFilters, normalizeFilters } from '../lib/watch.js'

process.env.DSH_SUPERAGENT_STATE = tempDir('zhuli-only-new-comments-')
process.env.DSH_SUPERAGENT_NO_POLL = '1'
process.env.DSH_SUPERAGENT_OFFLINE = '1'
process.env.DSH_SUPERAGENT_UPDATE_OFFLINE = '1'
assertTempStateDir('only-new-comments.test.mjs')

const mod = await import('../lib/index.js?only-new-comments=' + Date.now())
const { __test } = mod

// 用相对当前时间的日期，避免 pruneSeen 的 30 天遗忘窗口先把测试 seen 清掉。
const NOW = Date.now()
const atDay = (offset) => new Date(NOW + offset * 86400000).toISOString()
const BASE = atDay(-4)
const OLD = atDay(-3)
const NEW = atDay(-2)
const NEWER = atDay(-1)
const PUSH = atDay(0)

const ctx = {
  agents: { get: () => ({ status: 'idle' }), currentInitiator: () => ({ id: 'session-only-comments' }) },
  get: () => null,
}

function makeEntry(number = 1, extra = {}) {
  return {
    id: 'acme/comments#session-only-comments',
    repo: 'acme/comments', provider: 'github', sessionId: 'session-only-comments',
    enabled: true, observe: true, seen: {}, cursor: BASE, lastReported: {}, wakeTimes: [],
    filters: { ...normalizeFilters(), onlyNewComments: true },
    ...extra,
  }
}

function makeItem(number = 1, extra = {}) {
  return {
    number, title: '条目 ' + number, state: 'open', updated_at: PUSH,
    user: { login: 'octocat' }, labels: [], assignees: [], comments: 0,
    html_url: 'https://github.com/acme/comments/issues/' + number,
    ...extra,
  }
}

function parsed(items, etag = 'W/"next"') {
  return { status: 200, etag, body: JSON.stringify(items) }
}

function graphReply(number, comments) {
  return {
    data: {
      repository: {
        i0: {
          number,
          comments: { totalCount: comments.length, nodes: comments.map((at, index) => ({ author: { login: 'octocat' }, createdAt: at, databaseId: index + 1 })) },
          timelineItems: { nodes: [] },
        },
      },
    },
  }
}

function githubDeps({ discussion = [], review = [], reviewError = false } = {}) {
  const calls = []
  return {
    calls,
    ghRun: async (_file, args) => {
      calls.push(args)
      if (args.includes('graphql')) return { code: 0, stdout: JSON.stringify(graphReply(1, discussion)), stderr: '' }
      if (args.some((arg) => String(arg).includes('/pulls/'))) {
        if (reviewError) return { code: 1, stdout: '', stderr: 'review unavailable' }
        return { code: 0, stdout: JSON.stringify(review.map((at, index) => ({ created_at: at, id: 100 + index }))), stderr: '' }
      }
      if (args.some((arg) => String(arg).includes('/issues/'))) {
        return { code: 0, stdout: discussion.length ? JSON.stringify({ login: 'octocat', at: discussion.at(-1) }) : 'null', stderr: '' }
      }
      throw new Error('意外 gh 调用：' + args.join(' '))
    },
  }
}

async function poll(entry, items, deps) {
  await __test.pollWithItems(ctx, entry, 60000, parsed(items), null, deps)
}

test('normalizeFilters / mergeFilters 保留 onlyNewComments 布尔与部分更新', () => {
  assert.equal(normalizeFilters().onlyNewComments, false)
  assert.equal(normalizeFilters({ onlyNewComments: true }).onlyNewComments, true)
  assert.equal(normalizeFilters({ onlyNewComments: 1 }).onlyNewComments, false)
  const merged = mergeFilters({ labels: ['bug'], onlyNewComments: true }, { onlyAssigned: true })
  assert.equal(merged.onlyNewComments, true)
  assert.deepEqual(merged.labels, ['bug'])
  assert.equal(mergeFilters(merged, { onlyNewComments: false }).onlyNewComments, false)
})

test('onlyNewComments：无评论不唤醒且不推进 seen/cursor', async () => {
  const entry = makeEntry()
  await poll(entry, [makeItem()], githubDeps())
  assert.equal(entry.deferReason, null)
  assert.equal(entry.filterCounts['无新评论'], 1)
  assert.deepEqual(entry.seen, {})
  assert.equal(entry.cursor, BASE)
})

test('onlyNewComments：push 或改标签只更新 updated_at 时不唤醒', async () => {
  const entry = makeEntry()
  await poll(entry, [makeItem(1, { labels: [{ name: 'priority' }] })], githubDeps())
  assert.equal(entry.deferReason, null)
  assert.deepEqual(entry.seen, {})
  assert.equal(entry.cursor, BASE)
})

test('onlyNewComments：旧 discussion comment 不唤醒', async () => {
  const entry = makeEntry(1, { seen: { 1: OLD }, cursor: BASE })
  await poll(entry, [makeItem()], githubDeps({ discussion: [OLD] }))
  assert.equal(entry.deferReason, null)
  assert.equal(entry.obs['issue:1'].delivered, null)
  assert.deepEqual(entry.seen, { 1: OLD })
  assert.equal(entry.cursor, BASE)
})

test('onlyNewComments：新 discussion comment 唤醒并把水位推到评论时间', async () => {
  const entry = makeEntry()
  await poll(entry, [makeItem()], githubDeps({ discussion: [NEW] }))
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.obs['issue:1'].observedRound)
  assert.match(entry.obs['issue:1'].cursor, /^c:/)
})

test('onlyNewComments：GitHub PR discussion 与 review comments 取最新，review 能推水位', async () => {
  const entry = makeEntry()
  const deps = githubDeps({ discussion: [OLD], review: [NEWER] })
  await poll(entry, [makeItem(1, { pull_request: {} })], deps)
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.obs['issue:1'].observedRound)
  assert.match(entry.obs['issue:1'].cursor, /^c:/)
  assert.ok(deps.calls.some((args) => args.some((arg) => String(arg).includes('/pulls/1/comments'))), '必须查询 PR review comments')
})

test('onlyNewComments v2：同一 timestamp 的第二条评论靠计数继续候选', async () => {
  const entry = makeEntry(1, { watermarkVersion: 2, round: 0, obs: {}, observe: true })
  await poll(entry, [makeItem(1, { comments: 1 })], githubDeps({ discussion: [NEW] }))
  assert.equal(entry.deferReason, 'observe')
  const firstRound = entry.round
  await poll(entry, [makeItem(1, { comments: 2 })], githubDeps({ discussion: [NEW, NEW] }))
  assert.equal(entry.deferReason, 'observe', '同秒第二条评论不能被判成旧闻')
  assert.ok(entry.round > firstRound)
})

test('onlyNewComments v2：review id 不遮蔽 discussion 同秒新增', async () => {
  const entry = makeEntry(1, { watermarkVersion: 2, round: 0, obs: {}, observe: true })
  await poll(entry, [makeItem(1, { pull_request: {}, comments: 1 })], githubDeps({ discussion: [NEW], review: [NEW] }))
  const firstRound = entry.round
  await poll(entry, [makeItem(1, { pull_request: {}, comments: 2 })], githubDeps({ discussion: [NEW, NEW], review: [NEW] }))
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.round > firstRound, 'discussion 变化必须进入独立通道指纹')
})

test('onlyNewComments v2：GraphQL→REST 与下次 GraphQL 恢复不产生新内容', async () => {
  const entry = makeEntry(1, { watermarkVersion: 2, round: 0, obs: {}, observe: true })
  const fallback = {
    ghRun: async (_file, args) => {
      if (args.includes('graphql')) return { code: 1, stdout: '', stderr: 'temporary' }
      if (args.some((arg) => String(arg).includes('/pulls/'))) return { code: 0, stdout: JSON.stringify([{ created_at: NEW, id: 100 }]) }
      return { code: 0, stdout: JSON.stringify({ login: 'octocat', at: NEW }), stderr: '' }
    },
  }
  await poll(entry, [makeItem(1, { pull_request: {}, comments: 1 })], fallback)
  const firstRound = entry.round
  await poll(entry, [makeItem(1, { pull_request: {}, comments: 1 })], githubDeps({ discussion: [NEW], review: [NEW] }))
  assert.equal(entry.deferReason, null, '探测路径恢复不是新评论')
  assert.equal(entry.round, firstRound)
})

test('onlyNewComments：评论查询失败单独记账，不唤醒、不推水位且下轮强制重试', async () => {
  const entry = makeEntry(1, { etag: 'W/"old"' })
  const deps = { ghRun: async () => ({ code: 1, stdout: '', stderr: 'boom' }) }
  await poll(entry, [makeItem()], deps)
  assert.equal(entry.deferReason, null)
  assert.equal(entry.filterCounts['评论获取失败'], 1)
  assert.equal(entry.filterCounts['无新评论'], undefined)
  assert.deepEqual(entry.seen, {})
  assert.equal(entry.cursor, BASE)
  assert.equal(entry.etag, undefined, '不能提交 ETag，否则下轮 304 会把失败吞掉')
})

test('onlyNewComments：GitHub 评论空响应是获取失败，不是无评论', async () => {
  const entry = makeEntry()
  const deps = {
    ghRun: async (_file, args) => args.includes('graphql')
      ? { code: 1, stdout: '', stderr: 'graphql down' }
      : { code: 0, stdout: '', stderr: '' },
  }
  await poll(entry, [makeItem()], deps)
  assert.equal(entry.deferReason, null)
  assert.equal(entry.filterCounts['评论获取失败'], 1)
  assert.equal(entry.filterCounts['无新评论'], undefined)
  assert.deepEqual(entry.seen, {})
  assert.equal(entry.cursor, BASE)
  assert.equal(entry.etag, undefined)
})

test('onlyNewComments：Gitee PR discussion 与 review 两类评论取最新', async () => {
  const entry = makeEntry(8, { id: 'gitee:acme/comments#session-only-comments', provider: 'gitee' })
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const review = url.includes('comment_type=pr_comment')
    const body = review
      ? [{ id: 2, created_at: NEWER, user: { login: 'reviewer' }, body: 'review' }]
      : [{ id: 1, created_at: OLD, user: { login: 'discusser' }, body: 'discussion' }]
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  await poll(entry, [makeItem(8, { pull_request: {} })], { fetchImpl })
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.obs['issue:8'].observedRound)
  assert.match(entry.obs['issue:8'].cursor, /^c:/)
  assert.ok(calls.some((url) => url.includes('/pulls/8/comments?per_page=100')), '要有 pull discussion')
  assert.ok(calls.some((url) => url.includes('/pulls/8/comments?comment_type=pr_comment')), '要有 PR review')
})

test('onlyNewComments：Gitee issue discussion 新评论唤醒并走 issues 端点', async () => {
  const entry = makeEntry(9, { id: 'gitee:acme/comments#session-only-comments', provider: 'gitee' })
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1, created_at: NEW, user: { login: 'discusser' } }]) }
  }
  await poll(entry, [makeItem(9)], { fetchImpl })
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.obs['issue:9'].observedRound)
  assert.match(entry.obs['issue:9'].cursor, /^c:/)
  assert.ok(calls.some((url) => url.includes('/issues/9/comments?per_page=100')))
  assert.ok(calls.every((url) => !url.includes('comment_type=pr_comment')), '普通 issue 不应查询 PR review')
})

test('onlyNewComments：Gitee discussion 恰好 500 条时确认第 6 页为空后可唤醒', async () => {
  const entry = makeEntry(500, { id: 'gitee:acme/comments#session-only-comments', provider: 'gitee', seen: { 500: OLD } })
  const pages = []
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'))
    pages.push(page)
    const comments = page <= 5 ? Array.from({ length: 100 }, (_, index) => ({
      id: (page - 1) * 100 + index + 1,
      created_at: page === 5 && index === 99 ? NEW : OLD,
      user: { login: 'reader' },
    })) : []
    return { ok: true, status: 200, text: async () => JSON.stringify(comments) }
  }
  await poll(entry, [makeItem(500)], { fetchImpl })
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6])
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.obs['issue:500'].observedRound)
  assert.equal(entry.filterCounts['评论获取失败'], undefined)
})

test('onlyNewComments：Gitee discussion 超过 500 条时按获取失败重试，不假装已看到最新', async () => {
  const entry = makeEntry(501, { id: 'gitee:acme/comments#session-only-comments', provider: 'gitee', seen: { 501: OLD } })
  const pages = []
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'))
    pages.push(page)
    const comments = Array.from({ length: 100 }, (_, index) => ({
      id: (page - 1) * 100 + index + 1, created_at: OLD, user: { login: 'old' }, body: 'old',
    }))
    return { ok: true, status: 200, text: async () => JSON.stringify(comments) }
  }
  await poll(entry, [makeItem(501)], { fetchImpl })
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6])
  assert.equal(entry.deferReason, null)
  assert.equal(entry.filterCounts['评论获取失败'], 1)
  assert.equal(entry.filterCounts['无新评论'], undefined)
  assert.deepEqual(entry.seen, { 501: OLD })
  assert.equal(entry.cursor, BASE)
})

test('onlyNewComments：pending 在无新评论时不重提，pending 数据保留', async () => {
  const pending = { 1: { tries: 1, first: OLD, at: OLD } }
  const entry = makeEntry(1, { pending, seen: { 1: OLD } })
  await poll(entry, [makeItem()], githubDeps({ discussion: [OLD] }))
  assert.equal(entry.deferReason, null)
  assert.deepEqual(entry.pending, pending)
  assert.deepEqual(entry.seen, { 1: OLD })
  assert.equal(entry.cursor, BASE)
})

test('onlyNewComments：同批另有 fresh 时，pending 也不能搭车重提旧评论', async () => {
  const pending = { 2: { tries: 1, first: OLD, at: OLD } }
  const entry = makeEntry(1, { observe: false, pending, seen: { 2: OLD }, batchLimit: 5 })
  const state = __test.readState()
  state.watchers[entry.id] = entry
  __test.writeState(state)
  const calls = []
  const deps = {
    ghRun: async (_file, args) => {
      calls.push(args)
      if (!args.includes('graphql')) throw new Error('两条 issue 不应查询 PR review')
      return {
        code: 0, stderr: '',
        stdout: JSON.stringify({ data: { repository: {
          i0: { number: 1, comments: { nodes: [{ author: { login: 'a' }, createdAt: NEW }] }, timelineItems: { nodes: [] } },
          i1: { number: 2, comments: { nodes: [{ author: { login: 'b' }, createdAt: OLD }] }, timelineItems: { nodes: [] } },
        } } }),
      }
    },
    wake: async (_ctx, _session, message, done) => {
      calls.push(message)
      done({ ok: true })
    },
  }
  await poll(entry, [makeItem(1), makeItem(2)], deps)
  const message = String(calls.at(-1))
  assert.match(message, /条目 1/)
  assert.ok(!message.includes('条目 2'), '旧评论 pending 不得因另一条 fresh 搭车重提：' + message)
  assert.deepEqual(entry.pending[2], pending[2], '未通过新评论过滤的 pending 必须保留')
})

test('普通模式不受 onlyNewComments 查询与过滤影响', async () => {
  const entry = makeEntry(1, { filters: normalizeFilters() })
  await poll(entry, [makeItem()], { ghRun: async () => { throw new Error('普通模式不该查评论') } })
  assert.equal(entry.deferReason, 'observe')
  assert.ok(entry.obs['issue:1'].observedRound)
  assert.match(entry.obs['issue:1'].cursor, /^h:/)
})
