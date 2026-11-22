/**
 * 两层 Admission Eval 房。
 *
 * gate 是唯一授权入口：只有明确的 accept 才会调用 assessment；reject、
 * unknown、非法返回和异常都不会 fail-open。assessment 只决定接受、拒绝或
 * 未知，永远没有机会推翻已经完成的确定性拒绝。
 *
 * 端口：
 * - gate(candidate)：同步或异步返回 Decision；
 * - assessment(candidate, { signal, gate })：异步模型评估，可使用 signal 取消。
 *
 * Decision 可以是 accept/reject/unknown 字符串、{ disposition, reason }、
 * 布尔值或 { allowed, reason }；null/undefined 表示 unknown。所有返回均为
 * 新的完整结果：{ stage, disposition, reason, gate, assessment, error }。
 */

const DISPOSITIONS = new Set(['accept', 'reject', 'unknown'])
const DEFAULT_TIMEOUT_MS = 30_000

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalidResult(stage) {
  const error = new TypeError(`${stage} must return accept, reject, unknown, or an allowed/disposition result`)
  error.name = 'AdmissionResultError'
  error.code = stage === 'gate' ? 'GATE_INVALID_RESULT' : 'ASSESSMENT_INVALID_RESULT'
  return error
}

function normalizeDecision(value, stage) {
  let disposition

  if (value === null || value === undefined) {
    disposition = 'unknown'
  } else if (typeof value === 'boolean') {
    disposition = value ? 'accept' : 'reject'
  } else if (typeof value === 'string' && DISPOSITIONS.has(value)) {
    disposition = value
  } else if (isObject(value)) {
    if (value.disposition !== undefined) {
      if (!DISPOSITIONS.has(value.disposition)) throw invalidResult(stage)
      disposition = value.disposition
    } else {
      const hasAllowed = Object.hasOwn(value, 'allowed')
      const hasAllow = Object.hasOwn(value, 'allow')
      if (!hasAllowed && !hasAllow) throw invalidResult(stage)
      const allowed = hasAllowed ? value.allowed : value.allow
      if (allowed === null || allowed === undefined) disposition = 'unknown'
      else if (typeof allowed === 'boolean') disposition = allowed ? 'accept' : 'reject'
      else throw invalidResult(stage)
    }
  } else {
    throw invalidResult(stage)
  }

  const suppliedReason = isObject(value) && typeof value.reason === 'string'
    ? value.reason.trim()
    : ''
  return {
    disposition,
    reason: suppliedReason || `${stage}-${disposition}`,
  }
}

function errorResult(error, fallbackCode) {
  return {
    name: String(error && error.name || 'Error'),
    message: String(error && error.message || error || 'unknown error'),
    code: String(error && error.code || fallbackCode),
  }
}

function unknownDecision(stage, reason) {
  return { disposition: 'unknown', reason }
}

function completeResult(stage, gate, assessment, error = null) {
  const terminal = stage === 'gate' ? gate : assessment
  return {
    stage,
    disposition: terminal.disposition,
    reason: terminal.reason,
    gate: { ...gate },
    assessment: assessment ? { ...assessment } : null,
    error,
  }
}

function failedResult(stage, reason, gate, assessment, error, fallbackCode) {
  const failed = unknownDecision(stage, reason)
  return completeResult(
    stage,
    stage === 'gate' ? failed : gate,
    stage === 'assessment' ? failed : assessment,
    errorResult(error, fallbackCode),
  )
}

function timeoutError(timeoutMs) {
  const error = new Error(`assessment timed out after ${timeoutMs} ms`)
  error.name = 'TimeoutError'
  error.code = 'ASSESSMENT_TIMEOUT'
  return error
}

/**
 * 执行一次两层准入评估。timeoutMs=0 表示不为 assessment 设置房间级超时；
 * 默认 30 秒。调用方注入的 timers 只用于超时，不产生额外后台任务。
 */
export async function evaluateAdmission({
  candidate = null,
  gate,
  assessment,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timers = globalThis,
} = {}) {
  if (typeof gate !== 'function') throw new TypeError('evaluateAdmission requires gate')
  const budget = Number(timeoutMs)
  if (!Number.isFinite(budget) || budget < 0) {
    throw new TypeError('evaluateAdmission timeoutMs must be a non-negative finite number')
  }

  let gateDecision
  try {
    gateDecision = normalizeDecision(await gate(candidate), 'gate')
  } catch (error) {
    const invalid = error && error.name === 'AdmissionResultError'
    return failedResult(
      'gate',
      invalid ? 'gate-invalid' : 'gate-error',
      null,
      null,
      error,
      'GATE_ERROR',
    )
  }

  // 这里同时挡住 reject 与 unknown：assessment 不能成为第二授权入口。
  if (gateDecision.disposition !== 'accept') {
    return completeResult('gate', gateDecision, null)
  }

  if (typeof assessment !== 'function') {
    return failedResult(
      'assessment',
      'assessment-error',
      gateDecision,
      null,
      new TypeError('evaluateAdmission requires assessment after gate accept'),
      'ASSESSMENT_ERROR',
    )
  }

  const controller = new AbortController()
  let timer = null
  try {
    const pending = Promise.resolve().then(() => assessment(candidate, {
      signal: controller.signal,
      gate: { ...gateDecision },
    }))

    let rawAssessment
    if (budget === 0) {
      rawAssessment = await pending
    } else {
      const expired = new Promise((resolve, reject) => {
        timer = timers.setTimeout(() => {
          const error = timeoutError(budget)
          controller.abort(error)
          reject(error)
        }, budget)
      })
      rawAssessment = await Promise.race([pending, expired])
    }

    const assessmentDecision = normalizeDecision(rawAssessment, 'assessment')
    return completeResult('assessment', gateDecision, assessmentDecision)
  } catch (error) {
    const reason = error && error.code === 'ASSESSMENT_TIMEOUT'
      ? 'assessment-timeout'
      : error && error.name === 'AdmissionResultError'
        ? 'assessment-invalid'
        : 'assessment-error'
    return failedResult('assessment', reason, gateDecision, null, error, 'ASSESSMENT_ERROR')
  } finally {
    if (timer !== null) timers.clearTimeout(timer)
  }
}
