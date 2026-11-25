import assert from 'node:assert/strict'
import test from 'node:test'

import { deskQueue, loadClient, walk, watcher } from './fixtures/panel-harness.mjs'
import { createDraft } from '../lib/rooms/draft.js'

const AT = '2026-11-21T12:00:00.000Z'
const GLOBAL_PANEL_ID = 'session-superagent'
const RIGHT_TAB_ID = 'dsh-session-superagent/session'
const RIGHT_TAB_KIND = 'sessionSuperagent'

function navigationFixture() {
  const calls = { selectPanel: [], openTab: [], hide: [], definitions: [] }
  const tabs = []
  const listeners = new Set()
  const emit = () => { for (const listener of [...listeners]) listener() }
  const sessionCatalog = { phase: 'ready', byId: { 'session-a': { title: '会话 A' }, 'session-b': { title: '会话 B' } } }
  const services = {
    layout: { selectPanel: (id) => { calls.selectPanel.push(id) } },
    sidebarRight: {
      openTab: (...args) => {
        calls.openTab.push(args)
        const existing = tabs.find((tab) => tab.sessionId === 'session-a' && tab.kind === RIGHT_TAB_KIND)
        if (existing) existing.visible = true
        else tabs.push({ id: 'session-tab', sessionId: 'session-a', kind: RIGHT_TAB_KIND, visible: true })
        emit()
      },
      view: { subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } },
      tabsIn: (sessionId) => tabs.filter((tab) => tab.sessionId === sessionId),
      hide: (id) => {
        calls.hide.push(id)
        const tab = tabs.find((item) => item.id === id)
        if (tab) tab.visible = false
        emit()
      },
    },
    sidebarRightTabs: {
      register: (definition) => { calls.definitions.push(definition); return () => {} },
    },
    sessions: { list: { getSnapshot: () => sessionCatalog }, refresh: async () => {} },
  }
  return { calls, services, tabs, emit }
}

function registered(client, name, key) {
  const found = client.registrations.find((item) => item.opts.name === name
    && (item.opts.id === key || item.opts.key === key))
  assert.ok(found, 'missing registration: ' + name + '#' + key)
  return found
}

function jsonResponse(body = {}) {
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
}

function ticket(id, status, extra = {}) {
  return {
    id,
    threadKey: 'thread:' + id,
    status,
    ownerSessionId: status === 'assigned' ? 'session-a' : null,
    workdir: status === 'assigned' ? '/work/' + id : null,
    assignmentId: status === 'assigned' ? 'assignment-' + id : null,
    resumeCount: 0,
    createdAt: AT,
    updatedAt: AT,
    endedAt: status === 'ended' ? AT : null,
    endReason: null,
    history: [],
    historyCount: 0,
    ...extra,
  }
}

function fullModular(locale = 'zh') {
  const current = ticket('ticket-1', 'assigned')
  const ended = ticket('ticket-2', 'ended', { resumeCount: 2 })
  return {
    locale,
    records: {
      records: [current, ended],
      total: 2,
      counts: { open: 0, assigned: 1, waiting: 0, ended: 1 },
      outbox: {
        records: [
          { id: 'message-1', ticketId: 'ticket-1', channel: {}, body: 'working', status: 'pending', attempts: 0, nextAt: AT, createdAt: AT, updatedAt: AT },
          { id: 'message-2', ticketId: 'ticket-2', channel: {}, body: 'done', status: 'sent', attempts: 1, nextAt: AT, createdAt: AT, updatedAt: AT },
        ],
        total: 2,
        counts: { pending: 1, sending: 0, sent: 1, failed: 0, gone: 0 },
      },
    },
    execution: {
      current,
      assignment: { id: 'assignment-ticket-1', ticketId: 'ticket-1', sessionId: 'session-a', workdir: '/work/ticket-1', status: 'assigned', attempts: 1 },
      total: 2,
      activeCount: 1,
      counts: { open: 0, assigned: 1, waiting: 0, ended: 1 },
      running: 1,
      queued: 0,
      maxWorkers: 2,
      paused: false,
    },
    deployment: {
      status: 'error',
      stateDir: '/state',
      problem: { code: 'sendFailed', detail: 'delivery failed' },
      health: [
        { name: 'github', state: 'ready', code: null, detail: 'ok', values: {}, at: AT },
        { name: 'outbox', state: 'error', code: 'sendFailed', detail: 'delivery failed', values: {}, at: AT },
      ],
      counts: { total: 2, ready: 1, error: 1, starting: 0, paused: 0, unknown: 0 },
    },
    draft: {
      base: { goal: 'old goal' },
      value: { goal: 'draft goal' },
      revision: 3,
      phase: 'editing',
      dirty: true,
    },
  }
}

function unknownModular(locale = 'zh') {
  return {
    locale,
    records: {
      records: null,
      total: null,
      counts: { open: null, assigned: null, waiting: null, ended: null },
      outbox: {
        records: null,
        total: null,
        counts: { pending: null, sending: null, sent: null, failed: null, gone: null },
      },
    },
    execution: {
      current: null,
      assignment: null,
      total: null,
      activeCount: null,
      counts: { open: null, assigned: null, waiting: null, ended: null },
      running: null,
      queued: null,
      maxWorkers: null,
      paused: null,
    },
    deployment: {
      status: 'unknown',
      stateDir: null,
      problem: null,
      health: null,
      counts: { total: null, ready: null, error: null, starting: null, paused: null, unknown: null },
    },
    draft: null,
  }
}

function emptyModular(locale = 'zh') {
  return {
    locale,
    records: {
      records: [],
      total: 0,
      counts: { open: 0, assigned: 0, waiting: 0, ended: 0 },
      outbox: {
        records: [],
        total: 0,
        counts: { pending: 0, sending: 0, sent: 0, failed: 0, gone: 0 },
      },
    },
    execution: {
      current: null,
      assignment: null,
      total: 0,
      activeCount: 0,
      counts: { open: 0, assigned: 0, waiting: 0, ended: 0 },
      running: 0,
      queued: 0,
      maxWorkers: 0,
      paused: false,
    },
    deployment: {
      status: 'ready',
      stateDir: '/state',
      problem: null,
      health: [],
      counts: { total: 0, ready: 0, error: 0, starting: 0, paused: 0, unknown: 0 },
    },
    draft: { base: '', value: '', revision: 0, phase: 'clean', dirty: false },
  }
}

function renderModular(modular, { actions, onAction, sessionStorage } = {}) {
  const client = loadClient({ sessionStorage })
  const desk = client.registrations.find((registration) => registration.opts.name === 'main' && registration.opts.key === 'session-superagent')
  const snap = {
    loading: false,
    error: null,
    body: { sessionGoal: null, sessionTitle: 'session', credentials: {}, watchers: [], modular },
  }
  const queue = deskQueue(snap, null, {}, 'modular')
  const nodes = walk(client.render(desk, queue, {
    sessionId: 'session-a',
    modularActions: actions,
    onModularAction: onAction,
  }))
  return { client, desk, snap, queue, nodes }
}

function flatText(nodes) {
  return nodes.filter((node) => node.type === '#text').map((node) => node.text).join(' | ')
}

function nodeText(node) {
  return walk(node).filter((child) => child.type === '#text').map((child) => child.text).join('')
}

function button(nodes, label) {
  const found = nodes.find((node) => node.type === 'button' && nodeText(node) === label)
  assert.ok(found, 'missing button: ' + label + '; actual: ' + nodes.filter((node) => node.type === 'button').map(nodeText).join(', '))
  return found
}

function enabledButton(nodes, label) {
  const found = nodes.find((node) => node.type === 'button' && nodeText(node) === label && !node.props.disabled)
  assert.ok(found, 'missing enabled button: ' + label)
  return found
}

function prepareModularQueue(queue, lastIndex) {
  if (lastIndex > 24 && queue[24] === undefined) queue[24] = 'all'
  if (lastIndex > 25 && queue[25] === undefined) queue[25] = null
  for (let index = 26; index < lastIndex; index += 1) {
    if (queue[index] === undefined) queue[index] = false
  }
}

test('模块化视图只在 body.modular 存在时接入主面板，并完整渲染中文投影', () => {
  const plain = loadClient()
  const plainDesk = plain.registrations.find((registration) => registration.opts.name === 'main' && registration.opts.key === 'session-superagent')
  const plainSnap = { loading: false, error: null, body: { credentials: {}, watchers: [] } }
  const plainTabs = walk(plain.render(plainDesk, deskQueue(plainSnap)))
    .filter((node) => node.type === 'button' && node.props.role === 'tab')
  assert.equal(plainTabs.length, 4, '旧 body 不得多出模块化页签')

  const { nodes } = renderModular(fullModular('zh-CN'))
  const tabs = nodes.filter((node) => node.type === 'button' && node.props.role === 'tab')
  assert.equal(tabs.length, 5)
  assert.equal(nodeText(tabs[4]), '房间')
  assert.equal(tabs[4].props.id, 'sa-main-tab-modular')
  assert.equal(tabs[4].props['aria-controls'], 'sa-main-panel-modular')

  const panel = nodes.find((node) => node.props && node.props.role === 'tabpanel')
  assert.equal(panel.props.id, 'sa-main-panel-modular')
  assert.equal(panel.props['aria-labelledby'], 'sa-main-tab-modular')
  const text = flatText(nodes)
  for (const expected of [
    'Ticket records', '当前执行', '部署与健康', 'Outbox', '草稿',
    'ticket-1', 'ticket-2', 'assignment-ticket-1', 'session-a',
    'github', 'outbox', 'delivery failed', 'message-1', 'message-2',
    '恢复', '停止', '发送 Outbox', '保存草稿', '清空草稿',
  ]) assert.ok(text.includes(expected), 'modular view missing: ' + expected)
  const draftInput = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === '草稿内容')
  assert.ok(draftInput && draftInput.props.value.includes('draft goal'), '草稿 textarea 必须保留结构化值')
  assert.ok(!text.includes('[object Object]'), '结构化 problem/draft 不得直接转成 [object Object]')
  assert.ok(nodes.filter((node) => node.props && node.props.className === 'dt-section-title').every((node) => node.type === 'h2'))
})

test('未知 null 显示未知，显式空集合显示 0 与空态，二者不混淆', () => {
  const unknown = renderModular(unknownModular())
  const unknownCounts = unknown.nodes
    .filter((node) => node.props && node.props.className === 'dt-count')
    .map(nodeText)
  assert.deepEqual(unknownCounts, ['未知', '未知', '未知', '未知'])
  const unknownText = flatText(unknown.nodes)
  assert.ok(unknownText.includes('Ticket records 未知'))
  assert.ok(unknownText.includes('健康项未知'))
  assert.ok(unknownText.includes('Outbox 未知'))
  assert.ok(unknownText.includes('草稿未知'))
  assert.ok(!unknownText.includes('没有 Ticket records'))

  const empty = renderModular(emptyModular())
  const emptyCounts = empty.nodes
    .filter((node) => node.props && node.props.className === 'dt-count')
    .map(nodeText)
  assert.deepEqual(emptyCounts, ['0', '0', '0', '0'])
  const emptyText = flatText(empty.nodes)
  assert.ok(emptyText.includes('没有 Ticket records'))
  assert.ok(emptyText.includes('没有健康项'))
  assert.ok(emptyText.includes('Outbox 为空'))
  const loadLabels = empty.nodes.filter((node) => node.props && node.props.className === 'dt-lv').map(nodeText)
  assert.deepEqual(loadLabels, ['运行中 0 / 0', '排队 0'])
})

test('模块化视图使用 en 文案，并保留零值与结构化草稿', () => {
  const modular = fullModular('en-US')
  modular.execution.queued = 0
  modular.records.outbox.counts.failed = 0
  const { nodes } = renderModular(modular)
  const text = flatText(nodes)
  for (const expected of [
    'Rooms', 'Ticket records', 'Current execution', 'Deployment & health',
    'Resume', 'Stop', 'Flush outbox', 'Save draft', 'Clear draft',
  ]) assert.ok(text.includes(expected), 'English modular view missing: ' + expected)
  assert.ok(nodes.some((node) => node.props && node.props.className === 'dt-lv' && nodeText(node) === 'Queued 0'), 'Queued=0 must remain visible')
  assert.ok(nodes.some((node) => node.props && node.props.className === 'dt-tag' && nodeText(node) === 'Failed 0'), 'Outbox failed=0 must remain visible')
  const draftInput = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
  assert.ok(draftInput && draftInput.props.value.includes('draft goal'), 'English draft must keep its structured value')
  assert.ok(!text.includes('当前执行'))
  assert.ok(!text.includes('[object Object]'))
})

test('resume/stop/flush/save/clear 回调收到真实 Ticket 与草稿值', async () => {
  const calls = []
  const actions = {
    resume: (ticketId) => calls.push(['resume', ticketId]),
    stop: (ticketId) => calls.push(['stop', ticketId]),
    flush: () => calls.push(['flush']),
    save: (value, context) => calls.push(['save', value, context]),
    clear: (context) => calls.push(['clear', context]),
  }
  const rendered = renderModular(fullModular('en'), { actions })
  const { client, desk, snap, queue } = rendered
  let nodes = rendered.nodes

  enabledButton(nodes, 'Resume').props.onClick()
  enabledButton(nodes, 'Stop').props.onClick()
  assert.deepEqual(calls, [['resume', 'ticket-2']], '点击 Stop 只能开确认层')
  const opened = client.stateCalls().at(-1)
  prepareModularQueue(queue, opened.index)
  queue[opened.index] = true
  nodes = walk(client.render(desk, queue, { sessionId: 'session-a', modularActions: actions }))
  const confirmations = nodes.filter((node) => node.type === 'button' && nodeText(node) === 'Stop' && node.props['aria-haspopup'] !== 'dialog')
  assert.ok(confirmations.length > 0, '确认层必须有 Stop 按钮')
  await confirmations.at(-1).props.onClick()
  button(nodes, 'Flush outbox').props.onClick()
  assert.deepEqual(calls, [['resume', 'ticket-2'], ['stop', 'ticket-1'], ['flush']])

  const textarea = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
  assert.ok(textarea, 'draft must be editable')
  client.resetStateCalls()
  textarea.props.onChange({ target: { value: '{"goal":"new goal"}' } })
  const edit = client.stateCalls().at(-1)
  assert.equal(edit.next, '{"goal":"new goal"}')
  prepareModularQueue(queue, edit.index)
  queue[edit.index] = edit.next
  queue[edit.index + 1] = null
  nodes = walk(client.render(desk, queue, { sessionId: 'session-a', modularActions: actions }))
  await button(nodes, 'Save draft').props.onClick()
  button(nodes, 'Clear draft').props.onClick()
  assert.equal(JSON.stringify(calls.at(-2)), JSON.stringify(['save', { goal: 'new goal' }, { ticketId: 'ticket-1', body: { goal: 'new goal' }, revision: 3 }]))
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['clear', { ticketId: 'ticket-1', revision: 3, clear: true }]))

  client.resetStateCalls()
  const invalidInput = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
  invalidInput.props.onChange({ target: { value: '{invalid' } })
  const invalidEdit = client.stateCalls().at(-1)
  prepareModularQueue(queue, invalidEdit.index)
  queue[invalidEdit.index] = '{invalid'
  queue[invalidEdit.index + 1] = null
  nodes = walk(client.render(desk, queue, { sessionId: 'session-a', modularActions: actions }))
  await button(nodes, 'Save draft').props.onClick()
  assert.equal(calls.filter(([name]) => name === 'save').length, 1, 'invalid JSON must not invoke save')
  const validation = client.stateCalls().filter((call) => call.next === 'Draft must be valid JSON.').at(-1)
  assert.equal(validation.next, 'Draft must be valid JSON.')
  queue[validation.index] = validation.next
  nodes = walk(client.render(desk, queue, { sessionId: 'session-a', modularActions: actions }))
  assert.ok(flatText(nodes).includes('Draft must be valid JSON'))
  assert.ok(nodes.some((node) => node.props && node.props.role === 'alert'))
})

test('生产 {ticketId,body} 草稿只编辑 body，revision=0 不会被当成未知', async () => {
  const modular = emptyModular('en')
  modular.draft = createDraft({ ticketId: 'ticket-1', body: 'old text' }, { revision: 0 })
  const calls = []
  const actions = {
    save: (body, context) => calls.push({ body, context }),
    clear: (context) => calls.push({ clear: context }),
  }
  const { client, desk, queue, nodes } = renderModular(modular, { actions })
  const input = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
  assert.equal(input.props.value, 'old text')
  input.props.onChange({ target: { value: 'new text' } })
  const edit = client.stateCalls().at(-1)
  prepareModularQueue(queue, edit.index)
  queue[edit.index] = 'new text'
  queue[edit.index + 1] = null
  const edited = walk(client.render(desk, queue, { sessionId: 'session-a', modularActions: actions }))
  await enabledButton(edited, 'Save draft').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body, 'new text')
  assert.equal(calls[0].context.revision, 0)
  assert.equal(calls[0].context.body, 'new text')
  assert.equal(calls[0].context.ticketId, 'ticket-1')
  button(edited, 'Clear draft').props.onClick()
  assert.equal(JSON.stringify(calls[1].clear), JSON.stringify({ ticketId: 'ticket-1', revision: 0, clear: true }))
})

test('onModularAction 是可选的统一回调出口；没有回调时按钮不伪装可用', () => {
  const calls = []
  const unified = renderModular(fullModular('en'), {
    onAction: (name, payload) => calls.push([name, payload]),
  })
  enabledButton(unified.nodes, 'Resume').props.onClick()
  button(unified.nodes, 'Flush outbox').props.onClick()
  button(unified.nodes, 'Clear draft').props.onClick()
  assert.equal(calls[0][0], 'resume')
  assert.equal(calls[0][1].ticketId, 'ticket-2')
  assert.deepEqual(calls[1], ['flush', undefined])
  assert.equal(calls[2][0], 'clear')
  assert.equal(JSON.stringify(calls[2][1]), JSON.stringify({ ticketId: 'ticket-1', revision: 3, clear: true }))

  const disabled = renderModular(fullModular('en'))
  assert.equal(button(disabled.nodes, 'Resume').props.disabled, true)
  assert.equal(button(disabled.nodes, 'Stop').props.disabled, true)
  assert.equal(button(disabled.nodes, 'Flush outbox').props.disabled, true)
  assert.equal(button(disabled.nodes, 'Save draft').props.disabled, true)
  assert.equal(button(disabled.nodes, 'Clear draft').props.disabled, true)
})

test('另一标签页推进 revision 后，本地未保存草稿仍保留', () => {
  const modular = fullModular('en')
  modular.draft = {
    base: { ticketId: 'ticket-1', body: 'server-A' },
    value: { ticketId: 'ticket-1', body: 'server-A' },
    revision: 0, phase: 'clean', dirty: false,
  }
  const { client, desk, queue, snap, nodes } = renderModular(modular)
  const input = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
  input.props.onChange({ target: { value: 'client-B-unsaved' } })
  const edit = client.stateCalls().at(-1)
  prepareModularQueue(queue, edit.index)
  queue[edit.index] = 'client-B-unsaved'
  queue[edit.index + 1] = null
  const nextModular = {
    ...modular,
    draft: {
      ...modular.draft,
      value: { ticketId: 'ticket-1', body: 'server-A-new' },
      revision: 1,
    },
  }
  queue[0] = { ...snap, body: { ...snap.body, modular: nextModular } }
  const updated = walk(client.render(desk, queue, { sessionId: 'session-a' }))
  const preserved = updated.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
  assert.equal(preserved.props.value, 'client-B-unsaved')
})

test('主 tab 卸载后从 sessionStorage 恢复未保存草稿', () => {
  const values = new Map()
  globalThis.sessionStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  }
  try {
    const modular = fullModular('en')
    modular.draft = {
      base: { ticketId: 'ticket-1', body: 'saved' }, value: { ticketId: 'ticket-1', body: 'saved' },
      revision: 0, phase: 'clean', dirty: false,
    }
    const { client, desk, snap, queue, nodes } = renderModular(modular, { sessionStorage: globalThis.sessionStorage })
    const input = nodes.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
    input.props.onChange({ target: { value: 'keep-across-tabs' } })
    const edit = client.stateCalls().at(-1)
    prepareModularQueue(queue, edit.index)
    queue[edit.index] = 'keep-across-tabs'
    walk(client.render(desk, queue, { sessionId: 'session-a' }))
    client.runEffects()
    const remountQueue = deskQueue(snap, null, {}, 'modular')
    const remounted = walk(client.render(desk, remountQueue, { sessionId: 'session-a' }))
    const restored = remounted.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Draft value')
    assert.equal(restored.props.value, 'keep-across-tabs')
  } finally {
    delete globalThis.sessionStorage
  }
})

test('共享 SuperagentPage 接入左侧全局页、右栏正文/标题与开始页 definition', () => {
  const { calls, services } = navigationFixture()
  const client = loadClient({ services })
  const main = registered(client, 'main', GLOBAL_PANEL_ID)
  const sidebar = registered(client, 'sidebar.panellist', GLOBAL_PANEL_ID)
  const body = registered(client, 'sidebar.right.pane.tab', RIGHT_TAB_ID)
  const title = registered(client, 'sidebar.right.pane.tab.title', RIGHT_TAB_ID)
  registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  assert.equal(sidebar.opts.label(), '主理鱼')

  const globalTree = main.Component({})
  const sessionTree = body.Component({ sessionId: 'session-a' })
  assert.equal(globalTree.type, sessionTree.type, '两个容器必须复用同一个 SuperagentPage')
  assert.equal(globalTree.type.name, 'SuperagentPage')
  assert.equal(globalTree.props.scope, 'global')
  assert.equal(sessionTree.props.scope, 'session')
  assert.equal(sessionTree.props.sessionId, 'session-a')
  assert.ok(title.Component, '右栏标题必须与正文同 key 注册')

  assert.equal(calls.definitions.length, 1)
  const definition = calls.definitions[0]
  assert.equal(definition.id, RIGHT_TAB_ID)
  assert.equal(definition.kind, RIGHT_TAB_KIND)
  assert.equal(definition.priority, 'builtin')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'session-superagent')
  assert.equal(definition.guide[0].title(), '主理鱼')
  assert.equal(typeof definition.guide[0].icon, 'function')
  assert.match(definition.guide[0].description(), /Ticket.*Outbox.*草稿/)
})

test('会话头部与 Dock/Orbit 都只按 kind 打开当前 sessionId 的右栏', async () => {
  const { calls, services } = navigationFixture()
  const client = loadClient({ services })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const headerNodes = walk(client.render(header, [null, false], { sessionId: 'session-a' }))
  const headerButton = headerNodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.ok(headerButton)
  assert.equal(flatText(headerNodes).includes('主理鱼'), false, '头部 utility 只渲染图标，文字留在 aria-label/title')
  await headerButton.props.onClick()

  const orbit = registered(client, 'conversation.composer.dock', 'session-superagent-orbit')
  const orbitNodes = walk(client.render(orbit, [[watcher('a/b', { sessionId: 'session-a' })], null, false, null, '主理鱼'], { sessionId: 'session-a' }))
  const trigger = orbitNodes.find((node) => node.type === 'button' && String(node.props.className).includes('sa-orbit-trigger'))
  assert.ok(trigger)
  await trigger.props.onClick()
  assert.deepEqual(calls.openTab, [[RIGHT_TAB_KIND], [RIGHT_TAB_KIND]])
  assert.equal(calls.openTab.flat().some((value) => String(value).includes('sidebar://')), false)
})

test('会话头部订阅 sidebarRight.view，pressed 后对当前 Session 同 kind 页签二次 hide/toggle', async () => {
  const { calls, services, tabs } = navigationFixture()
  tabs.push({ id: 'other-kind', sessionId: 'session-a', kind: 'other', visible: true })
  const client = loadClient({ services })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const renderHeader = (visible) => walk(client.render(header, [null, visible], { sessionId: 'session-a' }))
  const headerButton = (nodes) => nodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')

  let nodes = renderHeader(false)
  assert.equal(headerButton(nodes).props['aria-pressed'], false)
  const cleanups = client.runEffects()
  assert.equal(cleanups.length, 1, '能力完整时必须真正订阅 sidebarRight.view')
  await headerButton(nodes).props.onClick()
  assert.deepEqual(calls.openTab, [[RIGHT_TAB_KIND]])
  assert.ok(client.stateCalls().some((call) => call.index === 1 && call.next === true), 'view 发布后 pressed 必须同步')

  nodes = renderHeader(true)
  assert.equal(headerButton(nodes).props['aria-pressed'], true)
  await headerButton(nodes).props.onClick()
  assert.deepEqual(calls.hide, ['session-tab'], '不得 hide 其它 kind 或其它 Session')
  assert.equal(calls.openTab.length, 1, '二次点击是 hide，不是再次 open')

  nodes = renderHeader(false)
  await headerButton(nodes).props.onClick()
  assert.equal(calls.openTab.length, 2, 'hide 后再次点击恢复 open/reveal')
  for (const cleanup of cleanups) cleanup()
})

test('sidebarRight.view/tabsIn/hide 能力缺失时头部明确保持 open-only', async () => {
  const { calls, services } = navigationFixture()
  services.sidebarRight = { openTab: (...args) => { calls.openTab.push(args) } }
  const client = loadClient({ services })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const nodes = walk(client.render(header, [null, false], { sessionId: 'session-a' }))
  const trigger = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.equal(trigger.props['aria-pressed'], false)
  assert.equal(trigger.props.disabled, false)
  assert.equal(client.runEffects().length, 0, '没有 view.subscribe 时不伪造可见性订阅')
  await trigger.props.onClick()
  await trigger.props.onClick()
  assert.deepEqual(calls.openTab, [[RIGHT_TAB_KIND], [RIGHT_TAB_KIND]])
  assert.deepEqual(calls.hide, [])
})

test('缺 sidebarRightTabs.register 时头部禁用并解释 definition 未注册', () => {
  const { services } = navigationFixture()
  delete services.sidebarRightTabs
  const client = loadClient({ services })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const nodes = walk(client.render(header, [null, false], { sessionId: 'session-a' }))
  const trigger = nodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.equal(trigger.props.disabled, true)
  assert.match(trigger.props.title, /sidebarRightTabs\.register 服务不存在/)
})

test('宿主服务晚于插件就绪时头部仍能挂上（真机 sidebarRight 报服务不存在的根因）', () => {
  const { services } = navigationFixture()
  // apply 时宿主服务一个都还没有 —— 真机首次加载就是这个时序。
  const live = {}
  const client = loadClient({ services: live, deferInject: true })
  assert.equal(client.registrations.some((r) => r.opts.id === 'session-superagent-current'), false,
    '服务全缺时头部本来就不该注册')
  // 宿主随后就绪，Cordis 触发 ctx.inject 回调
  Object.assign(live, services)
  assert.equal(client.flushInjects(), 1, '应登记过一次动态注入')
  const header = client.registrations.find((r) => r.opts.id === 'session-superagent-current')
  assert.ok(header, '服务就绪后必须补挂头部入口')
  const tree = client.render(header, [null, false], { sessionId: 'session-a' })
  const trigger = walk(tree).find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.ok(trigger, '必须渲染出头部按钮')
  assert.equal(trigger.props.disabled, false, '拿到 sidebarRight 后不能再显示禁用')
})

test('头部图标是官方鲸鱼线稿，且不再借用带底色的 toolbar variant', () => {
  const { services } = navigationFixture()
  const Tooltip = function HostTooltip() {}
  const Button = function HostButton() {}
  const client = loadClient({ services, primitives: { Tooltip, Button } })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const tree = client.render(header, [null, false], { sessionId: 'session-a' })
  const trigger = tree.props.children[0].props.children[0]
  // 官方 Forge 的头部入口不传 variant：默认 ghost 才没有底色，toolbar 会带一块填充。
  assert.equal(trigger.props.variant, 'ghost', '不得再用 toolbar（真机上就是那块深色底）')
  assert.equal(trigger.props.className, 'dt-header-entry dt-header-entry-host')
  const icon = trigger.props.icon
  // 入口图标是 SuperagentNavIcon 包一层，里面必须是品牌鲸鱼而不是旧轨道环。
  assert.equal(icon.type.name, 'SuperagentNavIcon')
  const nodes = walk(icon)
  const svg = nodes.find((node) => node.type === 'svg')
  assert.equal(svg.props.viewBox, '0 0 50 50', '官方 whale 视口')
  const path = nodes.find((node) => node.type === 'path')
  assert.equal(path.props.fill, 'none', '线稿不填色')
  assert.equal(path.props.stroke, 'currentColor', '颜色跟随主题文字色')
  assert.ok(String(path.props.d).length > 2000, '用的是官方 whale path 本体')
  // 只留主轮廓与尾鳍：眼睛(301)与腹部纹理(673)两段被去掉，16px 下才不会糊。
  assert.equal(String(path.props.d).match(/[Mm]/g).length, 2, '简化后只剩两段子路径')
  // 状态环只留在面板内部：入口里的鲸鱼自己不带卫星点。
  assert.equal(nodes.filter((node) => node.type === 'circle').length, 0)
})

test('头部优先复用官方 Tooltip，缺原语才回退原生 title', () => {
  const { services } = navigationFixture()
  const Tooltip = function HostTooltip() {}
  const Button = function HostButton() {}
  const client = loadClient({ services, primitives: { Tooltip, Button } })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const tree = client.render(header, [null, false], { sessionId: 'session-a' })
  const tooltip = tree.props.children[0]
  assert.equal(tooltip.type, Tooltip)
  assert.equal(tooltip.props.label, '本会话的主理鱼')
  assert.equal(tooltip.props.side, 'bottom')
  assert.equal(tooltip.props.openOnClick, true)
  const trigger = tooltip.props.children[0]
  assert.equal(trigger.props['aria-pressed'], false)
  assert.equal(trigger.props.title, undefined, '官方 Tooltip 路径不再重复原生 title')

  const fallback = loadClient({ services })
  const fallbackHeader = registered(fallback, 'conversation.session.header.utilities', 'session-superagent-current')
  const fallbackNodes = walk(fallback.render(fallbackHeader, [null, false], { sessionId: 'session-a' }))
  const fallbackTrigger = fallbackNodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.equal(fallbackTrigger.props.title, '本会话的主理鱼')

  const withoutButton = loadClient({ services, primitives: { Tooltip } })
  const withoutButtonHeader = registered(withoutButton, 'conversation.session.header.utilities', 'session-superagent-current')
  const withoutButtonNodes = walk(withoutButton.render(withoutButtonHeader, [null, false], { sessionId: 'session-a' }))
  const withoutButtonTrigger = withoutButtonNodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.equal(withoutButtonTrigger.props.title, '本会话的主理鱼', '只有 Tooltip、没有 forwardRef Button 时必须显式回退')
})

test('宿主服务缺失时头部明确禁用，Dock 显示旧操作列表降级原因', () => {
  const { services } = navigationFixture()
  delete services.sidebarRight
  delete services.sidebarRightTabs
  const client = loadClient({ services })
  const header = registered(client, 'conversation.session.header.utilities', 'session-superagent-current')
  const headerNodes = walk(client.render(header, [null, false], { sessionId: 'session-a' }))
  const headerButton = headerNodes.find((node) => node.type === 'button' && node.props['aria-label'] === '本会话的主理鱼')
  assert.equal(headerButton.props.disabled, true)
  assert.match(headerButton.props.title, /sidebarRight\.openTab 服务不存在/)

  const orbit = registered(client, 'conversation.composer.dock', 'session-superagent-orbit')
  const nodes = walk(client.render(orbit, [[], null, true, { x: 200, y: 400 }, '主理鱼']))
  assert.ok(flatText(nodes).includes('宿主 sidebarRight 服务不存在；已保留旧操作列表。'))
  assert.ok(registered(client, 'main', GLOBAL_PANEL_ID), '缺右栏服务不能连累左侧全局页')
})

test('旧中栏注册已删除，品牌改名仍重注册右栏 definition 与标题', () => {
  const { calls, services } = navigationFixture()
  const values = new Map()
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
  const client = loadClient({ services, localStorage })
  assert.equal(client.registrations.some((item) => item.opts.name === 'conversation.view'), false)
  assert.equal(calls.definitions.length, 1)

  localStorage.setItem('dsh-session-superagent.tab-name', '夜猫')
  assert.equal(client.dispatchWindowEvent('storage', { key: 'dsh-session-superagent.tab-name', newValue: '夜猫' }), 1)
  assert.equal(calls.definitions.length, 2, 'definition 必须先释放再重注册')
  assert.equal(calls.definitions.at(-1).title(), '夜猫')
  assert.equal(calls.definitions.at(-1).guide[0].title(), '夜猫')
  const title = client.liveRegistrations().find((item) => item.opts.name === 'sidebar.right.pane.tab.title'
    && item.opts.key === RIGHT_TAB_ID)
  assert.ok(flatText(walk(client.render(title, []))).includes('夜猫'))
  assert.ok(registered(client, 'main', GLOBAL_PANEL_ID))
  assert.ok(registered(client, 'conversation.composer.dock', 'session-superagent-orbit'))
})

test('全局/会话读取显式分流；右栏缺 sessionId 时不回退读取全局', async () => {
  const reads = []
  const { services } = navigationFixture()
  const client = loadClient({
    services,
    fetch: async (url) => {
      reads.push(String(url))
      return jsonResponse({ watchers: [], credentials: {}, modular: null })
    },
  })
  const main = registered(client, 'main', GLOBAL_PANEL_ID)
  const right = registered(client, 'sidebar.right.pane.tab', RIGHT_TAB_ID)
  const loading = () => deskQueue({ loading: true, error: null, body: null })

  let nodes = walk(client.render(main, loading()))
  await button(nodes, '刷新').props.onClick()
  assert.deepEqual(reads.splice(0).filter((url) => url.includes('/state')), ['/session-superagent/state?scope=global'])

  nodes = walk(client.render(right, loading(), { sessionId: 'session-a' }))
  await button(nodes, '刷新').props.onClick()
  assert.deepEqual(reads.splice(0).filter((url) => url.includes('/state')), ['/session-superagent/state?sessionId=session-a'])

  nodes = walk(client.render(right, loading()))
  assert.ok(flatText(nodes).includes('右栏 slot 没有提供当前 sessionId；未读取全局数据，也未发出任何会话写操作。'))
  client.runEffects()
  assert.equal(reads.some((url) => url.includes('/state')), false, '缺 sessionId 不得通过 discoverBase 或 load 读取全局状态')
})

test('会话右栏内建 Ticket/Outbox/草稿写操作都携带当前 sessionId', async () => {
  const writes = []
  const modular = { ...fullModular(), actions: true }
  const { services } = navigationFixture()
  const client = loadClient({
    services,
    fetch: async (url, init = {}) => {
      if (String(init.method || '').toUpperCase() === 'POST') writes.push({ url: String(url), body: JSON.parse(init.body || '{}') })
      return jsonResponse({ watchers: [], credentials: {}, modular })
    },
  })
  const right = registered(client, 'sidebar.right.pane.tab', RIGHT_TAB_ID)
  const queue = deskQueue({ loading: false, error: null, body: { credentials: {}, watchers: [], modular } }, null, {}, 'modular')
  const nodes = walk(client.render(right, queue, { sessionId: 'session-a' }))
  await enabledButton(nodes, '恢复').props.onClick()
  await button(nodes, '发送 Outbox').props.onClick()
  await button(nodes, '保存草稿').props.onClick()
  await button(nodes, '清空草稿').props.onClick()

  assert.deepEqual(writes.map((write) => write.url), [
    '/session-superagent/tickets', '/session-superagent/outbox',
    '/session-superagent/draft', '/session-superagent/draft',
  ])
  for (const write of writes) assert.equal(write.body.sessionId, 'session-a', write.url + ' 缺少 sessionId')
  assert.equal(writes.some((write) => write.body.action === 'pause-processing'), false, '会话页不得发出全局 processing pause')
})

test('全局页复用 sessions catalog 选择新建目标，sessionId 只进入新建请求', async () => {
  const writes = []
  const reads = []
  const { services } = navigationFixture()
  const client = loadClient({
    services,
    fetch: async (url, init = {}) => {
      if (String(init.method || '').toUpperCase() === 'POST') writes.push({ url: String(url), body: JSON.parse(init.body || '{}') })
      else reads.push(String(url))
      return jsonResponse({ watchers: [], credentials: {}, modular: null })
    },
  })
  const main = registered(client, 'main', GLOBAL_PANEL_ID)
  const snap = { loading: false, error: null, body: { credentials: {}, watchers: [], modular: null } }
  const queue = deskQueue(snap, null, {}, 'trigger')
  queue[3] = { ...queue[3], repo: 'acme/new' }
  let nodes = walk(client.render(main, queue))
  const target = nodes.find((node) => node.type === 'select' && node.props['aria-label'] === '目标会话')
  assert.ok(target)
  target.props.onChange({ target: { value: 'session-a' } })
  const changed = client.stateCalls().at(-1)
  assert.equal(changed.index, 3, '目标选择复用现有 form hook，不插入新的位置化 hook')
  queue[3] = changed.next

  nodes = walk(client.render(main, queue))
  const submit = button(nodes, '添加到所选会话')
  assert.equal(queue[3].createSessionId, 'session-a')
  assert.equal(submit.props.disabled, false)
  await submit.props.onClick({ preventDefault() {} })
  const created = writes.find((write) => write.url === '/session-superagent/watch')
  assert.ok(created, JSON.stringify(writes))
  assert.equal(created.body.sessionId, 'session-a')
  assert.equal(created.body.repo, 'acme/new')
  assert.ok(reads.includes('/session-superagent/state?scope=global'))
  assert.equal(reads.some((url) => url.includes('sessionId=session-a')), false, '全局读取不能被新建目标改成会话 scope')
})

test('全局新建缺 sessions catalog 时显示真实错误且不伪造可建状态', async () => {
  const writes = []
  const { services } = navigationFixture()
  delete services.sessions
  const client = loadClient({
    services,
    fetch: async (url, init = {}) => {
      if (String(init.method || '').toUpperCase() === 'POST') writes.push(String(url))
      return jsonResponse({ watchers: [], credentials: {}, modular: null })
    },
  })
  const main = registered(client, 'main', GLOBAL_PANEL_ID)
  const snap = { loading: false, error: null, body: { credentials: {}, watchers: [], modular: null } }
  const queue = deskQueue(snap, null, {}, 'trigger')
  queue[3] = { ...queue[3], repo: 'acme/new' }
  const nodes = walk(client.render(main, queue))
  assert.ok(flatText(nodes).includes('宿主 sessions catalog 不可用，无法选择目标会话。'))
  const target = nodes.find((node) => node.type === 'select' && node.props['aria-label'] === '目标会话')
  assert.equal(target.props.disabled, true)
  const submit = button(nodes, '选择目标会话')
  assert.equal(submit.props.disabled, true)
  await submit.props.onClick({ preventDefault() {} })
  assert.equal(writes.includes('/session-superagent/watch'), false)
})
