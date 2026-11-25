import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../lib/index.js'

test('Admission：Cordis 未 inject 可选服务时不抛错，按原默认放行', async () => {
  const ctx = new Proxy({ get: () => undefined }, {
    get(target, key, receiver) {
      if (key === 'admissionGate' || key === 'admissionAssessment') {
        throw new Error(`cannot get property "${key}" without inject`)
      }
      return Reflect.get(target, key, receiver)
    },
  })
  const items = [{ number: 1 }, { number: 2 }]
  assert.deepEqual(await __test.filterAdmissionBatch(ctx, items), items)
})

test('Admission：宿主 ctx.get 提供的 gate/assessment 仍被使用', async () => {
  let assessments = 0
  const services = {
    admissionGate: (candidate) => candidate.number === 1,
    admissionAssessment: () => { assessments += 1; return 'accept' },
  }
  const ctx = { get: (name) => services[name] }
  const accepted = await __test.filterAdmissionBatch(ctx, [{ number: 1 }, { number: 2 }])
  assert.deepEqual(accepted, [{ number: 1 }])
  assert.equal(assessments, 1)
})
