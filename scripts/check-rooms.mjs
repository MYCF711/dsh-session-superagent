#!/usr/bin/env node
/** 房间依赖边界：只允许公开端口方向的 import，禁止跨房顺手拿内部实现。 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RULES = {
  'watermark-state.js': [],
  'watermark-decision.js': [],
  'data-provider.js': [],
  'delivery.js': ['./watermark-state.js'],
  'scheduler.js': [],
  'projection.js': ['./watermark-decision.js'],
  'ticket-state.js': [],
  'thread-subscription.js': [],
  'execution-assignment.js': ['./ticket-state.js'],
  'executor-host.js': [],
  'outbox.js': [],
  'admission-eval.js': [],
  'source-registry.js': ['./data-provider.js'],
  'skill-pack.js': [],
  'ticket-projection.js': [],
  'draft.js': [],
  'prompt-config.js': [],
  'i18n.js': [],
  'modular-runtime.js': ['./ticket-state.js', './thread-subscription.js', './execution-assignment.js', './executor-host.js', './admission-eval.js', './ticket-projection.js', './draft.js', './prompt-config.js', './i18n.js'],
  'modular-outbox-host.js': ['./outbox.js'],
}

export function inspectRoomImports(file, text) {
  const allowed = RULES[file] || []
  const sources = []
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
  for (const match of String(text).matchAll(pattern)) sources.push(match[1])
  const violations = sources
    .filter((source) => source.startsWith('./') || source.startsWith('../rooms/'))
    .filter((source) => source.includes('rooms/') || source.startsWith('./'))
    .filter((source) => !allowed.includes(source))
  return { file, sources, ok: violations.length === 0, violations }
}

export function checkRooms(root = ROOT) {
  return Object.keys(RULES).map((file) => inspectRoomImports(file, readFileSync(join(root, 'lib/rooms', file), 'utf8')))
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  const reports = checkRooms()
  for (const report of reports) {
    console.log(`${report.ok ? 'PASS' : 'FAIL'} ${report.file}${report.ok ? '' : ' -> ' + report.violations.join(', ')}`)
  }
  const failed = reports.filter((report) => !report.ok)
  console.log(`${failed.length === 0 ? 'PASS' : 'FAIL'} 房间依赖边界（${reports.length} 房）`)
  if (failed.length > 0) process.exitCode = 1
}
