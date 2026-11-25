import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAdmission } from '../lib/rooms/admission-eval.js'

const gateAccept = { disposition: 'accept', reason: 'gate-accept' }
const noTimers = {
  setTimeout: () => { throw new Error('short-circuit must not create a timer') },
  clearTimeout: () => {},
}

function manualTimers() {
  const state = { callback: null, delay: null, cleared: false }
  return {
    state,
    setTimeout(callback, delay) {
      state.callback = callback
      state.delay = delay
      return { id: 1 }
    },
    clearTimeout() {
      state.cleared = true
      state.callback = null
    },
    fire() {
      const callback = state.callback
      assert.equal(typeof callback, 'function', 'timeout must be armed')
      callback()
    },
  }
}

test('Admission：确定性 gate reject 直接短路，模型接受也不能推翻', async () => {
  let modelCalls = 0
  const candidate = { id: 'trigger:1', body: 'do not run' }
  const before = structuredClone(candidate)
  const out = await evaluateAdmission({
    candidate,
    gate: () => ({ disposition: 'reject', reason: 'author-not-listed' }),
    assessment: async () => {
      modelCalls += 1
      return { disposition: 'accept', reason: 'model-overreach' }
    },
    timers: noTimers,
  })

  assert.deepEqual(out, {
    stage: 'gate',
    disposition: 'reject',
    reason: 'author-not-listed',
    gate: { disposition: 'reject', reason: 'author-not-listed' },
    assessment: null,
    error: null,
  })
  assert.equal(modelCalls, 0)
  assert.deepEqual(candidate, before, '评估不得修改候选输入')
})

test('Admission：gate unknown 与非法返回均不放行，也不调用模型', async () => {
  let modelCalls = 0
  const assessment = async () => { modelCalls += 1; return 'accept' }
  const unknown = await evaluateAdmission({
    gate: () => ({ allowed: null, reason: 'policy-missing' }), assessment, timers: noTimers,
  })
  assert.equal(unknown.stage, 'gate')
  assert.equal(unknown.disposition, 'unknown')
  assert.equal(unknown.reason, 'policy-missing')
  assert.equal(unknown.error, null)

  const invalid = await evaluateAdmission({ gate: () => ({ allowed: 'yes' }), assessment, timers: noTimers })
  assert.equal(invalid.stage, 'gate')
  assert.equal(invalid.disposition, 'unknown')
  assert.equal(invalid.reason, 'gate-invalid')
  assert.equal(invalid.error.name, 'AdmissionResultError')
  assert.equal(invalid.error.code, 'GATE_INVALID_RESULT')
  assert.equal(modelCalls, 0)
})

test('Admission：gate 放行后 assessment accept 给出完整两层结果并清理定时器', async () => {
  const timers = manualTimers()
  let receivedSignal
  let receivedGate
  const out = await evaluateAdmission({
    candidate: { id: 'trigger:2' },
    gate: () => true,
    assessment: async (candidate, context) => {
      assert.equal(candidate.id, 'trigger:2')
      receivedSignal = context.signal
      receivedGate = context.gate
      return { disposition: 'accept', reason: 'actionable-request' }
    },
    timeoutMs: 50,
    timers,
  })

  assert.deepEqual(out, {
    stage: 'assessment',
    disposition: 'accept',
    reason: 'actionable-request',
    gate: gateAccept,
    assessment: { disposition: 'accept', reason: 'actionable-request' },
    error: null,
  })
  assert.deepEqual(receivedGate, gateAccept)
  assert.equal(receivedSignal.aborted, false)
  assert.equal(timers.state.delay, 50)
  assert.equal(timers.state.cleared, true)
  assert.equal(timers.state.callback, null)
})

test('Admission：assessment reject 与 unknown 都保留各自语义', async () => {
  const rejected = await evaluateAdmission({
    gate: () => ({ allowed: true, reason: 'listed-author' }),
    assessment: async () => ({ disposition: 'reject', reason: 'discussion-only' }),
    timeoutMs: 0,
  })
  assert.equal(rejected.stage, 'assessment')
  assert.equal(rejected.disposition, 'reject')
  assert.equal(rejected.reason, 'discussion-only')
  assert.deepEqual(rejected.gate, { disposition: 'accept', reason: 'listed-author' })
  assert.equal(rejected.error, null)

  const unknown = await evaluateAdmission({
    gate: () => true,
    assessment: async () => null,
    timeoutMs: 0,
  })
  assert.deepEqual(unknown, {
    stage: 'assessment',
    disposition: 'unknown',
    reason: 'assessment-unknown',
    gate: gateAccept,
    assessment: { disposition: 'unknown', reason: 'assessment-unknown' },
    error: null,
  })
})

test('Admission：gate 异常显式降级为 unknown，不吞错误且不进入模型', async () => {
  let modelCalls = 0
  const failure = new Error('policy store unavailable')
  failure.code = 'POLICY_DOWN'
  const out = await evaluateAdmission({
    gate: async () => { throw failure },
    assessment: async () => { modelCalls += 1; return 'accept' },
    timers: noTimers,
  })

  assert.equal(out.stage, 'gate')
  assert.equal(out.disposition, 'unknown')
  assert.equal(out.reason, 'gate-error')
  assert.deepEqual(out.gate, { disposition: 'unknown', reason: 'gate-error' })
  assert.equal(out.assessment, null)
  assert.deepEqual(out.error, { name: 'Error', message: 'policy store unavailable', code: 'POLICY_DOWN' })
  assert.equal(modelCalls, 0)
})

test('Admission：模型异常显式降级，同时保留已通过的 gate 与原始错误', async () => {
  const failure = new Error('model endpoint failed')
  failure.code = 'MODEL_DOWN'
  const out = await evaluateAdmission({
    gate: () => true,
    assessment: async () => { throw failure },
    timeoutMs: 0,
  })

  assert.equal(out.stage, 'assessment')
  assert.equal(out.disposition, 'unknown')
  assert.equal(out.reason, 'assessment-error')
  assert.deepEqual(out.gate, gateAccept)
  assert.deepEqual(out.assessment, { disposition: 'unknown', reason: 'assessment-error' })
  assert.deepEqual(out.error, { name: 'Error', message: 'model endpoint failed', code: 'MODEL_DOWN' })
})

test('Admission：模型非法返回不会伪造接受，错误原因完整可见', async () => {
  const out = await evaluateAdmission({
    gate: () => true,
    assessment: async () => ({ disposition: 'definitely-accept' }),
    timeoutMs: 0,
  })

  assert.equal(out.stage, 'assessment')
  assert.equal(out.disposition, 'unknown')
  assert.equal(out.reason, 'assessment-invalid')
  assert.equal(out.error.name, 'AdmissionResultError')
  assert.equal(out.error.code, 'ASSESSMENT_INVALID_RESULT')
  assert.match(out.error.message, /assessment must return/)
})

test('Admission：超时返回 unknown + TimeoutError，发出取消并清理定时器', async () => {
  const timers = manualTimers()
  let signal
  let rejectLate
  const pending = evaluateAdmission({
    gate: () => true,
    assessment: async (candidate, context) => {
      signal = context.signal
      return new Promise((resolve, reject) => { rejectLate = reject })
    },
    timeoutMs: 25,
    timers,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.state.delay, 25)
  timers.fire()
  const out = await pending

  assert.equal(out.stage, 'assessment')
  assert.equal(out.disposition, 'unknown')
  assert.equal(out.reason, 'assessment-timeout')
  assert.deepEqual(out.gate, gateAccept)
  assert.deepEqual(out.assessment, { disposition: 'unknown', reason: 'assessment-timeout' })
  assert.deepEqual(out.error, {
    name: 'TimeoutError',
    message: 'assessment timed out after 25 ms',
    code: 'ASSESSMENT_TIMEOUT',
  })
  assert.equal(signal.aborted, true)
  assert.equal(timers.state.cleared, true)

  // 超时后的迟到 reject 也必须已被 Promise.race 接管，不能成为未处理拒绝。
  rejectLate(new Error('late model failure'))
  await new Promise((resolve) => setImmediate(resolve))
})

test('Admission：gate 放行但缺少模型端口时显式降级且不 fail-open', async () => {
  const out = await evaluateAdmission({ gate: () => true, timeoutMs: 0 })
  assert.equal(out.stage, 'assessment')
  assert.equal(out.disposition, 'unknown')
  assert.equal(out.reason, 'assessment-error')
  assert.equal(out.error.code, 'ASSESSMENT_ERROR')
  assert.match(out.error.message, /requires assessment/)
})
