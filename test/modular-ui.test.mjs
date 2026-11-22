import assert from 'node:assert/strict'
import test from 'node:test'

import { deskQueue, loadClient, walk } from './fixtures/panel-harness.mjs'
import { createDraft } from '../lib/rooms/draft.js'

const AT = '2026-11-21T12:00:00.000Z'

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
  const desk = client.registrations.find((registration) => registration.opts.id === 'session-superagent-desk')
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
  const plainDesk = plain.registrations.find((registration) => registration.opts.id === 'session-superagent-desk')
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
