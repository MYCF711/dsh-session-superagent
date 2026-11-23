/**
 * 「这条守是不是启用着」—— 全仓唯一判据。
 *
 * 为什么单独一个文件：`watchers.json` 是**人也会手改**的文件，真机踩过
 * `enabled: "false"` 字符串让守照常轮询。而这个判据至少有三处消费者，
 * 且它们分属不同层：
 *
 * - `lib/index.js` 的调度器（要不要起定时器）
 * - `lib/watch.js` 的 `pollHealth`（算不算停摆）
 * - `lib/rooms/projection.js` 的 `projectWatcher`（`watch_status` 公开 JSON 里 `enabled` 报什么）
 *
 * 以前每处各写一份，写法还不一样（`=== false` / `!== false` / 完整别名表）。
 * 结果就是 PR #68 review 复现的那个自相矛盾：`statusView([{enabled:'off'}])`
 * 返回的 watcher 同时是 `enabled: true`，而 `pollHealth` 判 `paused` ——
 * 同一份公开 JSON 里两个字段互相打架。
 *
 * 放在最底层（不 import 任何本仓模块），三个方向都能引用，不会造出循环依赖。
 */

/**
 * @param {unknown} entry 一条 watcher 记录（或任何带 `enabled` 的对象）
 * @returns {boolean} 是否启用。缺陷值（`undefined` / `null` / 没这个字段）算**启用** ——
 *   老状态文件里没有这个字段，缺省必须是「在跑」，否则升级那一刻所有守都会静默停摆。
 */
export function isWatcherEnabled(entry) {
  if (!entry || typeof entry !== 'object') return false
  const value = entry.enabled
  if (value === undefined || value === null) return true
  if (value === false || value === 0) return false
  const text = String(value).trim().toLowerCase()
  return !(text === 'false' || text === '0' || text === 'no' || text === 'off')
}
