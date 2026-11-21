import assert from 'node:assert/strict'
import test from 'node:test'
import { checkRooms, inspectRoomImports } from '../scripts/check-rooms.mjs'

test('房间边界：六个真实房间没有非法依赖回边', () => {
  const reports = checkRooms()
  assert.equal(reports.length, 6)
  assert.deepEqual(reports.filter((report) => !report.ok), [])
})

test('房间边界：交付房偷读决策实现必须被点名', () => {
  const report = inspectRoomImports('delivery.js', "import { decideWatermark } from './watermark-decision.js'\n")
  assert.equal(report.ok, false)
  assert.deepEqual(report.violations, ['./watermark-decision.js'])
})
