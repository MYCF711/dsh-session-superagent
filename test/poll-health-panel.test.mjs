/**
 * 面板侧：轮询停摆（`poll`）必须真的让 UI 变红。
 *
 * PR #68 review 第 3、5 条的现场：服务端已经算出 `poll: 'stalled'`，
 * 但面板两处没消费它 ——
 *   3. 「按仓库」汇总仍只在 `lastError` 时加 `errors`，于是主行红了、底部还是绿点；
 *   5. `hasProblem()` 认了 `poll`，但 `problems` 数组没加对应项，于是「筛选能选中、
 *      顶部告警区却是空的」。
 *
 * ⚠️ 两个坑，都是第一版踩了变异验证才发现的：
 *
 * 1. **不能用 `text.includes(...)` 扫全页**。删掉 `problems` 里的 poll 项，它照样绿 ——
 *    因为「未配置 token」那条 problem 让「需要关注」区块永远存在，而「轮询停了」
 *    这几个字在行内副行里也出现过一次。必须定位到**具体区块的子树**。
 * 2. **`walk()` 返回的是扁平数组**（`test/fixtures/panel-harness.mjs` 把文本变成
 *    `{ type: '#text', text }` 推进同一个 out，层级已经丢了）。所以「子树」只能用
 *    **索引切片**表达：从 `dt-section` 到下一个 `dt-section` 之间就是那个区块的内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { deskQueue, loadClient, walk, watcher } from './fixtures/panel-harness.mjs'

/** 扁平数组里的可见文本（`walk` 把字符串压成 `#text` 节点）。 */
const textOf = (nodes) => nodes.filter((n) => n.type === '#text' && typeof n.text === 'string').map((n) => n.text).join(' | ')
const classOf = (node) => String(node.props?.className || '')
const hasClass = (node, name) => classOf(node).split(/\s+/).includes(name)
const isSection = (node) => hasClass(node, 'dt-section')

/**
 * 取标题为 `title` 的那个 `dt-section` 的内容（扁平数组切片）。
 * 空数组表示这个区块不存在 —— 与「存在但内容为空」区分开。
 */
/** 从 `index` 往后第一个文本节点（`walk` 把字符串压成 `#text`，元素节点自己没有 text）。 */
function textAfter(nodes, index) {
  for (let i = index + 1; i < nodes.length; i += 1) {
    if (nodes[i].type === '#text') return nodes[i].text
  }
  return ''
}

function sectionSlice(nodes, title) {
  const titleIndex = nodes.findIndex((node) => hasClass(node, 'dt-section-name') && textAfter(nodes, nodes.indexOf(node)) === title)
  if (titleIndex < 0) return null
  // 往回找最近的 dt-section 起点（标题在 section 之后）
  let start = -1
  for (let i = titleIndex; i >= 0; i -= 1) { if (isSection(nodes[i])) { start = i; break } }
  if (start < 0) return null
  let end = nodes.length
  for (let i = start + 1; i < nodes.length; i += 1) { if (isSection(nodes[i])) { end = i; break } }
  return nodes.slice(start, end)
}

/** 第 `index` 个 `dt-stage` 的文案与色调（就是那一行的状态标签）。 */
function stageAt(nodes, index = 0) {
  const stages = nodes.filter((node) => hasClass(node, 'dt-stage'))
  const node = stages[index]
  if (!node) return null
  const at = nodes.indexOf(node)
  return { state: node.props?.['data-state'], label: textOf(nodes.slice(at, at + 4)).replace(/^ \| /, '').split(' | ')[0] }
}

const stateBody = (extra = {}) => ({
  sessionGoal: null,
  sessionTitle: '会话',
  // token 留空 → 会多一条「未配置 token」的 problem。这是**故意**的：
  // 它让「需要关注」区块在任何情况下都存在，从而逼着断言必须看区块**内容**而不是区块**有无**。
  credentials: { token: 'none', sshKeyPath: 'none' },
  gh: { ok: true },
  defaults: { sessionMaxWakes: 12, maxWakesPerHour: 6, isolateKeepDays: 3, batchLimit: 5 },
  brandName: '主理鱼',
  defaultAckLabels: { github: '主理鱼:已处理', gitee: '主理鱼-已处理' },
  watchers: [],
  ...extra,
})

const renderDesk = (client, watchers, snapshotExtra = {}) =>
  walk(client.render(client.registrations.find((r) => r.opts.id === 'session-superagent-desk'), deskQueue({
    loading: false, error: null, ...snapshotExtra, body: stateBody({ watchers }),
  })))

test('停摆的守即使没有 lastError，「需要关注」区块里也必须有一条（review 第 5 条）', () => {
  const nodes = renderDesk(loadClient(), [
    // 关键：lastError 是 null —— 停摆时它本来就该是 null（压根没发起请求），
    // 所以「只在 lastError 时报警」这条路它永远走不到。
    watcher('acme/stalled', { poll: 'stalled', lastError: null }),
  ])
  const section = sectionSlice(nodes, '需要关注')
  assert.ok(section, '只有停摆问题时也必须出现「需要关注」区块')
  const inside = textOf(section)
  assert.ok(inside.includes('轮询停了'), '「需要关注」里要说「轮询停了」：' + inside)
  assert.ok(inside.includes('acme/stalled'), '「需要关注」里要指出是哪条守：' + inside)
})

test('boot-miss 在「需要关注」里说「重启后没跑起来」，不是「轮询停了」（review 第 5 条）', () => {
  const nodes = renderDesk(loadClient(), [watcher('acme/boot', { poll: 'boot-miss', lastError: null })])
  const inside = textOf(sectionSlice(nodes, '需要关注'))
  assert.ok(inside.includes('重启后没跑起来'), 'boot-miss 要说「重启后没跑起来」：' + inside)
  assert.equal(inside.includes('轮询停了'), false, 'boot-miss 不该混用「轮询停了」：' + inside)
})

test('停摆的守会让「按仓库」汇总报错，不再只标主行（review 第 3 条）', () => {
  const nodes = renderDesk(loadClient(), [
    // 同样 lastError=null：旧实现只看 lastError，于是这条仓库的汇总点是绿的
    watcher('acme/repo-stalled', { poll: 'stalled', lastError: null }),
  ])
  const section = sectionSlice(nodes, '按仓库')
  assert.ok(section, '应当有「按仓库」区块')
  const inside = textOf(section)
  assert.ok(/1 条报错/.test(inside), '按仓库汇总必须把 poll 计进 errors：' + inside)
  // 汇总点必须是 error 态，不能是 warning / done
  const dot = section.find((node) => hasClass(node, 'dt-state-dot'))
  assert.equal(dot?.props?.['data-state'], 'error', '按仓库的圆点必须是 error 态：' + JSON.stringify(dot?.props))
})

test('健康守 + 停摆守混在一起时，按仓库只数停摆那条（review 第 3 条）', () => {
  const nodes = renderDesk(loadClient(), [
    watcher('acme/mixed', { poll: null, lastError: null }),
    watcher('acme/mixed', { poll: 'stalled', lastError: null }),
  ])
  const inside = textOf(sectionSlice(nodes, '按仓库'))
  assert.ok(/1 条报错/.test(inside), '两条守里只有一条停摆，汇总应当是 1 条报错：' + inside)
  assert.ok(/2 条守/.test(inside), '同时条数仍应是 2：' + inside)
})

test('全部健康时不该凭空多出轮询告警（反向）', () => {
  const nodes = renderDesk(loadClient(), [watcher('acme/ok', { poll: null, lastError: null })])
  const problems = textOf(sectionSlice(nodes, '需要关注') || [])
  assert.equal(problems.includes('轮询停了'), false, '健康守不该出现「轮询停了」：' + problems)
  assert.equal(problems.includes('重启后没跑起来'), false, '健康守不该出现「重启后没跑起来」')
  const summary = textOf(sectionSlice(nodes, '按仓库') || [])
  assert.equal(/条报错/.test(summary), false, '健康守不该在汇总里报错：' + summary)
})

test('enabled 的暂停别名在面板上算「已暂停」（review 第 4 条）', () => {
  for (const alias of ['off', 0, 'no', 'false', ' off ']) {
    const nodes = renderDesk(loadClient(), [watcher('acme/paused', { enabled: alias })])
    // 只看那一行的舞台标签，不扫全页：页面上别处也有「已暂停」字样（统计条/按钮）
    const stage = stageAt(nodes)
    assert.ok(stage, 'enabled=' + JSON.stringify(alias) + ' 应当渲染出舞台标签')
    assert.equal(stage.label, '已暂停', 'enabled=' + JSON.stringify(alias) + ' 面板必须显示「已暂停」')
    assert.equal(stage.state, 'warning', '暂停态必须是 warning 色调，不是 error')
  }
})

test('enabled 正常时舞台标签是「主理中」（反向，证明上一条不是恒真）', () => {
  const nodes = renderDesk(loadClient(), [watcher('acme/live', { enabled: true })])
  const stage = stageAt(nodes)
  assert.equal(stage?.label, '主理中', '启用中的守必须是「主理中」')
  assert.equal(stage?.state, undefined, 'active 态不该带 data-state')
})

test('暂停别名的守必须能看到「恢复」按钮，不能只显示「暂停」（review 第 4 条的下游影响）', () => {
  // 只看**那一行**的动作区：页面顶部固定有「全部暂停」「全部恢复」两个批量按钮，
  // 扫全页会把它们算进来（第一版就是这么假红的）。
  const rowActions = (nodes) => {
    const at = nodes.findIndex((node) => hasClass(node, 'dt-ticket-actions'))
    if (at < 0) return ''
    let end = nodes.length
    for (let i = at + 1; i < nodes.length; i += 1) {
      if (hasClass(nodes[i], 'dt-ticket')) { end = i; break }
    }
    return textOf(nodes.slice(at, end))
  }
  for (const alias of ['off', 0, 'no']) {
    const actions = rowActions(renderDesk(loadClient(), [watcher('acme/pa', { enabled: alias })]))
    assert.ok(actions.includes('恢复'), 'enabled=' + JSON.stringify(alias) + ' 行内必须出现「恢复」按钮，否则用户永远点不回来：' + actions)
    assert.equal(actions.includes('暂停'), false, 'enabled=' + JSON.stringify(alias) + ' 行内不该出现「暂停」按钮：' + actions)
  }
  // 反向：启用中的守行内必须是「暂停」按钮（证明上一条不是恒真）
  const live = rowActions(renderDesk(loadClient(), [watcher('acme/live', { enabled: true })]))
  assert.ok(live.includes('暂停'), '启用中行内必须有「暂停」按钮：' + live)
  assert.equal(live.includes('恢复'), false, '启用中行内不该出现「恢复」：' + live)
})

test('停摆的守**主行**必须画成「异常」，不能只靠「需要关注」文案（review 第 5 条核心）', () => {
  // 对抗性审计的 D7 变异：`if (w.poll) return 'error'` 改成 `return 'active'`，
  // 之前 8 条用例全绿 —— 因为只断言了「需要关注」的**文本**，没断言主行状态。
  // 而 review 原话就是「主行已经异常时……仍可能显示正常」，主行才是用户第一眼。
  const nodes = renderDesk(loadClient(), [watcher('acme/dead', { poll: 'stalled', lastError: null })])
  const stage = stageAt(nodes)
  assert.equal(stage?.label, '异常', '停摆的守主行必须写「异常」：' + JSON.stringify(stage))
  assert.equal(stage?.state, 'error', '主行的舞台标签必须是 error 色调')
  // 统计条也要算进异常数（否则「0 异常」+ 一行「异常」自相矛盾）。
  // 只看 `dt-stats` 子树 —— 扫全页会被主行自己的「异常」二字命中，等于恒真。
  const statsAt = nodes.findIndex((node) => hasClass(node, 'dt-stats'))
  assert.ok(statsAt >= 0, '应当有统计条')
  let statsEnd = nodes.length
  for (let i = statsAt + 1; i < nodes.length; i += 1) {
    if (isSection(nodes[i]) || hasClass(nodes[i], 'dt-rows')) { statsEnd = i; break }
  }
  // 统计条是「数字 | 标签」交替渲染，拆成无分隔再匹配
  const stats = textOf(nodes.slice(statsAt, statsEnd)).split(' | ').join(' ')
  // 中文字符不是 \w，`\b` 在「异常」后面不成立 —— 用拆词后的精确子串
  assert.ok(stats.split(' ').join(' ').includes('1 异常'), '统计条的异常计数必须是 1（不是 0）：' + stats)
})

test('「只看有问题」必须把停摆的守算进去（review 第 5 条原话里的「筛选」）', () => {
  // 对抗性审计的 D2 变异：`hasProblem` 删掉 `Boolean(watcher.poll)`，之前 11 条全绿 ——
  // 因为没断言筛选计数。这个数字就是 `hasProblem` 的直接投影：
  // 两条守里只有一条停摆，计数必须是 1（变异后变 0）。
  const render2 = (watchers) => renderDesk(loadClient(), watchers)
  const countOf = (nodes) => {
    const at = nodes.findIndex((node) => node.type === '#text' && /只看有问题的 \(\d+\)/.test(node.text))
    assert.ok(at >= 0, '应当有「只看有问题的 (N)」按钮：' + textOf(nodes).slice(0, 400))
    return Number(nodes[at].text.match(/\((\d+)\)/)[1])
  }
  assert.equal(countOf(render2([
    watcher('acme/stalled', { poll: 'stalled', lastError: null }),
    watcher('acme/healthy', { poll: null, lastError: null }),
  ])), 1, '两条守里一条停摆 → 「只看有问题的」必须是 1')
  // 反向：两条都停摆 → 2（证明这个数字是逐条算的，不是恒 1）。
  // 不用「全健康 → 0」：0 条时面板根本不渲染这个按钮，断言会落到「按钮不存在」上，
  // 那测的就不是计数了。
  assert.equal(countOf(render2([
    watcher('acme/a', { poll: 'stalled', lastError: null }),
    watcher('acme/b', { poll: 'boot-miss', lastError: null }),
  ])), 2, '两条都停摆 → 必须是 2')
})

test('停摆告警排在最前（rank 0），不能被「未配置 token」之类的静态提示压后（review 第 5 条）', () => {
  // 对抗性审计的 D1 变异：rank 0 → 99，之前全绿。用户打开「需要关注」第一眼要看到
  // 「守根本没在工作」，「未配置 token」是配置提示，不该排在它前面。
  const nodes = renderDesk(loadClient(), [watcher('acme/order', { poll: 'stalled', lastError: null })])
  const section = sectionSlice(nodes, '需要关注')
  assert.ok(section, '应当有「需要关注」')
  const text = textOf(section)
  const pollAt = text.indexOf('轮询停了')
  const credAt = text.indexOf('token')
  assert.ok(pollAt >= 0, '必须有轮询停摆条目：' + text)
  if (credAt >= 0) assert.ok(pollAt < credAt, '轮询停摆必须排在「未配置 token」之前：' + text)
})

test('按仓库汇总的「启用 N 条」也必须走统一判据（对抗审计 D3：当前代码对但零保护）', () => {
  const nodes = renderDesk(loadClient(), [
    watcher('acme/alias', { enabled: 'off' }),
    watcher('acme/alias', { enabled: true }),
  ])
  const inside = textOf(sectionSlice(nodes, '按仓库')).split(' | ').join(' ')
  assert.ok(inside.includes('2 条守（启用 1）'), '两条守里一条是暂停别名 → 启用数必须是 1：' + inside)
})

test('暂停别名的守不该让「全部暂停」可点（对抗审计 D5b）', () => {
  const nodes = renderDesk(loadClient(), [watcher('acme/allalias', { enabled: 'off' })])
  const bulkButton = (label) => nodes.find((node) => {
    if (!node.props || node.props.type !== 'button') return false
    const at = nodes.indexOf(node)
    return textOf(nodes.slice(at, at + 5)).includes(label)
  })
  const pauseBtn = bulkButton('全部暂停')
  assert.ok(pauseBtn, '应当有「全部暂停」按钮')
  // 已经是暂停态的守，「全部暂停」必须置灰（否则点了什么都不动，与行内「已暂停」矛盾）。
  // `resumable = visible.length - pausable`，所以这一条同时锁住了「全部恢复」可点。
  assert.equal(pauseBtn.props.disabled, true, '全部是暂停态时「全部暂停」必须 disabled')
})
