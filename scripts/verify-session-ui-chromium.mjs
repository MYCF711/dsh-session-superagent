// task-22：真实 Chromium 中的会话级导航最小验收。
// 真实 client.js + 安装版 React/primitives；宿主 slot/导航服务由本脚本仿真，API 全部是 loopback fixture。
// 不进入真实 DSH Web GUI，不访问 GitHub，不改产品代码，不执行真实仓库写操作。
// 运行：{ printf 三个 env prelude；cat 本文件； } | ego-browser nodejs

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ELECTRON_EXE = 'DeepSeek Harness.exe'
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'
const GLOBAL_PANEL = 'session-superagent'
const RIGHT_KIND = 'sessionSuperagent'
const SPACE_NAME = 'dsh-session-ui-task-28'
const results = []
const apiLog = []
const screenshots = []
const observations = []

function fail(message) {
  console.error('verify-session-ui-chromium: ' + message)
  process.exit(2)
}
function resolveRepo(env, importUrl, cwd) {
  if (env.DSH_SUPERAGENT_REPO) return resolve(env.DSH_SUPERAGENT_REPO)
  if (typeof importUrl === 'string' && importUrl.startsWith('file:') && !importUrl.includes('[eval')) {
    return resolve(dirname(fileURLToPath(importUrl)), '..')
  }
  return cwd
}
function scanInstallRoots(parents) {
  const found = []
  for (const parent of parents) {
    let names = []
    try { names = readdirSync(parent) } catch { continue }
    for (const name of names) {
      const root = join(parent, name)
      const asar = join(root, 'resources', 'app.asar')
      const electron = join(root, ELECTRON_EXE)
      if (existsSync(asar) && existsSync(electron)) found.push({ root, asar, electron, mtimeMs: statSync(asar).mtimeMs })
    }
  }
  return found
}
function resolveInstall(env) {
  if (env.DSH_INSTALL_ROOT) {
    const root = resolve(env.DSH_INSTALL_ROOT)
    const asar = join(root, 'resources', 'app.asar')
    const electron = join(root, ELECTRON_EXE)
    if (!existsSync(asar) || !existsSync(electron)) fail('DSH_INSTALL_ROOT 缺 app.asar 或 Electron：' + root)
    return { root, asar, electron, source: 'env:DSH_INSTALL_ROOT' }
  }
  const parents = []
  if (env.DSH_INSTALL_SCAN) for (const part of env.DSH_INSTALL_SCAN.split(delimiter)) if (part.trim()) parents.push(resolve(part.trim()))
  else {
    if (env.DSH_HOME) parents.push(resolve(env.DSH_HOME, '..'))
    if (env.DSH_PROFILE_DIR) parents.push(resolve(env.DSH_PROFILE_DIR, '..', '..', '..'))
  }
  const candidates = scanInstallRoots([...new Set(parents)]).sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (!candidates.length) fail('找不到 DSH 安装；请传 DSH_INSTALL_ROOT')
  return { ...candidates[0], source: 'scan:mtime-latest' }
}

const REPO = resolveRepo(process.env, import.meta.url, process.cwd())
if (!existsSync(join(REPO, 'client.js'))) fail('仓库根无效：' + REPO)
const INSTALL = resolveInstall(process.env)
const ASAR = INSTALL.asar
const FRONTEND = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-web-frontend`
const THEME_CLIENT = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`
const THEME_SRC_STYLES = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles`
const ARTIFACTS = process.env.DSH_SESSION_UI_ARTIFACTS
  ? resolve(process.env.DSH_SESSION_UI_ARTIFACTS)
  : join(REPO, 'tmp-artifacts', 'session-ui-interactive')
mkdirSync(ARTIFACTS, { recursive: true })

const sha256 = (body) => createHash('sha256').update(body).digest('hex')
function check(name, pass, detail) {
  const row = { name, pass: Boolean(pass), detail }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  return row.pass
}
function observe(name, detail) {
  observations.push({ name, detail })
  console.log(`OBSERVE ${name} ${JSON.stringify(detail)}`)
}
async function waitFor(predicate, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待 fixture 条件超时')
}

function loadInstalledAssets() {
  const reader = String.raw`
const fs = require('fs');
const crypto = require('crypto');
const root = process.argv[1];
const dist = root + '/dist';
const html = fs.readFileSync(dist + '/index.html', 'utf8');
const names = [];
for (const match of html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)) {
  if (/\.(?:js|css)$/.test(match[1]) && !names.includes(match[1])) names.push(match[1]);
}
const assets = {};
for (const name of names) {
  const body = fs.readFileSync(dist + '/' + name);
  assets[name] = { base64: body.toString('base64'), sha256: crypto.createHash('sha256').update(body).digest('hex') };
}
const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'));
const themeClient = fs.readFileSync(process.argv[3], 'utf8');
const themeStyles = {};
for (const match of themeClient.matchAll(/var ([A-Za-z0-9_]+_css_default) = ("(?:[^"\\]|\\.)*");/g)) themeStyles[match[1]] = JSON.parse(match[2]);
const files = { base_css_default:'base.css', corner_shape_css_default:'corner-shape.css', design_platform_css_default:'design-platform.css', focus_css_default:'focus.css', onboarding_css_default:'onboarding.css', scrollbar_css_default:'scrollbar.css', gradient_shadow_text_css_default:'gradient-shadow-text.css', shiki_css_default:'shiki.css' };
for (const [name, file] of Object.entries(files)) {
  if (typeof themeStyles[name] !== 'string') {
    const path = process.argv[4] + '/' + file;
    if (fs.existsSync(path)) themeStyles[name] = fs.readFileSync(path, 'utf8');
  }
  if (typeof themeStyles[name] !== 'string') throw new Error('missing official theme style: ' + name);
}
process.stdout.write(JSON.stringify({ frontendVersion:pkg.version, assets, themeStyles }));
`
  const output = execFileSync(INSTALL.electron, ['-e', reader, FRONTEND, ASAR, THEME_CLIENT, THEME_SRC_STYLES], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  })
  const parsed = JSON.parse(output)
  parsed.asarSha256 = sha256(readFileSync(ASAR))
  for (const asset of Object.values(parsed.assets)) asset.body = Buffer.from(asset.base64, 'base64')
  return parsed
}

const CAPTURE_FACADE = `
window.__captureErrors = [];
window.__networkViolations = [];
window.__registrations = {};
window.__definitions = [];
window.__navigationCalls = { selectPanel: [], openTab: [], hide: [] };
window.__ModuleLoader__ = {
  create(options) { window.__capturedModules = options.staticModules; window.__captured = true; throw new Error('intentional-capture-stop'); },
  load(options) { window.__clientFactory = options.factory; window.__clientCaptured = true; },
};
window.addEventListener('error', (event) => window.__captureErrors.push(String(event.message || event.error || '')));
window.addEventListener('unhandledrejection', (event) => window.__captureErrors.push(String(event.reason || '')));
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input && input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin) {
    window.__networkViolations.push(url.href);
    return Promise.reject(new Error('harness 禁止外部请求'));
  }
  return nativeFetch(input, { ...(init || {}), cache: 'no-store' });
};
`
const HARNESS_CSS = `
html,body{margin:0;min-height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
#root{display:none!important}button,input,select,textarea{font:inherit}
.harness{height:100vh;display:grid;grid-template-columns:180px minmax(0,1fr);overflow:hidden}
.harness.has-right{grid-template-columns:180px minmax(0,1fr) minmax(0,520px)}
.harness-nav{padding:16px 10px;background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column;gap:8px}
.harness-nav button{min-height:36px;text-align:left}.harness-main,.harness-right{min-width:0;min-height:0;overflow:hidden}
.harness-right{border-left:1px solid var(--dsw-alias-border-l3)}
.harness-header{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l3)}
.harness-right-title{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l3)}
.harness-right-body{height:calc(100% - 44px)}.harness-conversation{height:calc(100% - 52px);padding:24px}
@media(max-width:700px){.harness{grid-template-columns:64px minmax(0,1fr)}.harness.has-right{grid-template-columns:64px minmax(0,1fr) 50vw}.harness-nav{padding:8px 4px}.harness-nav button{font-size:11px;padding:4px}}
`
const HARNESS_MODULE = `
try {
  const deadline = Date.now() + 15000;
  while (!window.__captured && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!window.__captured) throw new Error('没有捕获安装版 staticModules');
  const modules = window.__capturedModules;
  const React = modules.react;
  const ReactDOM = modules['react-dom/client'];
  await import('/client.js');
  if (!window.__clientCaptured) throw new Error('真实 client.js 未注册');
  const localRequire = (name) => {
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    if (name === 'cordis' || name === 'zod') return {};
    throw new Error('安装 bundle 未提供模块：' + name);
  };
  const plugin = window.__clientFactory(localRequire);
  const nav = { panel: null, right: false, sessionId: ${JSON.stringify(SESSION_A)} };
  const listeners = new Set();
  const viewListeners = new Set();
  const rightTabs = [{ id:'other-kind', sessionId:${JSON.stringify(SESSION_A)}, kind:'other', visible:true }];
  const emit = () => { for (const fn of listeners) fn(); };
  const publishRight = () => { emit(); for (const fn of [...viewListeners]) fn(); };
  const catalog = { phase:'ready', byId:{ ${JSON.stringify(SESSION_A)}:{title:'当前项目会话'}, ${JSON.stringify(SESSION_B)}:{title:'目标项目会话'} } };
  const services = {
    layout: { selectPanel(id) {
      if (id !== null && id !== ${JSON.stringify(GLOBAL_PANEL)}) throw new Error('未知 panel：' + id);
      window.__navigationCalls.selectPanel.push(id); nav.panel = id; emit();
    } },
    sidebarRight: {
      openTab(kind) {
        if (kind !== ${JSON.stringify(RIGHT_KIND)}) throw new Error('未知 right kind：' + kind);
        window.__navigationCalls.openTab.push([kind]);
        const existing = rightTabs.find((tab) => tab.sessionId === nav.sessionId && tab.kind === kind);
        if (existing) existing.visible = true;
        else rightTabs.push({id:'session-tab',sessionId:nav.sessionId,kind,visible:true});
        nav.right = true; publishRight();
      },
      view: { subscribe(listener) { viewListeners.add(listener); return () => viewListeners.delete(listener); } },
      tabsIn(sessionId) { return rightTabs.filter((tab) => tab.sessionId === sessionId); },
      hide(id) {
        window.__navigationCalls.hide.push(id);
        const tab = rightTabs.find((item) => item.id === id && item.sessionId === nav.sessionId);
        if (!tab) throw new Error('未知 right tab：' + id);
        tab.visible = false; nav.right = false; publishRight();
      },
    },
    sidebarRightTabs: { register(definition) { window.__definitions.push(definition); return () => {}; } },
    sessions: { list:{getSnapshot:() => catalog}, refresh:async () => {} },
    uiWorkspace: { openSession(id) { nav.sessionId = id; emit(); } },
  };
  const ctx = {
    get:(name) => services[name], effect:(fn) => fn(),
    slots:{
      inject:(_name,fn) => fn(),
      register(options,Component) {
        const key = options.name + '#' + (options.id || options.key);
        window.__registrations[key] = { options, Component };
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  function HostApp() {
    const [, redraw] = React.useState(0);
    React.useEffect(() => { const fn = () => redraw((n) => n + 1); listeners.add(fn); return () => listeners.delete(fn); }, []);
    const global = window.__registrations['main#${GLOBAL_PANEL}'];
    const globalNav = window.__registrations['sidebar.panellist#${GLOBAL_PANEL}'];
    const header = window.__registrations['conversation.session.header.utilities#session-superagent-current'];
    const right = window.__registrations['sidebar.right.pane.tab#dsh-session-superagent/session'];
    const title = window.__registrations['sidebar.right.pane.tab.title#dsh-session-superagent/session'];
    if (!global || !globalNav || !header || !right || !title) throw new Error('目标 slot 注册不完整');
    return React.createElement('div',{className:'harness' + (nav.right ? ' has-right':'')},
      React.createElement('nav',{className:'harness-nav','aria-label':'验收导航'},
        React.createElement('button',{id:'nav-conversation',onClick:() => services.layout.selectPanel(null)},'当前会话'),
        React.createElement('button',{id:'nav-global',onClick:() => services.layout.selectPanel(${JSON.stringify(GLOBAL_PANEL)})},
          React.createElement(globalNav.Component),globalNav.options.label())),
      React.createElement('main',{className:'harness-main'}, nav.panel === ${JSON.stringify(GLOBAL_PANEL)}
        ? React.createElement('section',{id:'global-panel'},React.createElement(global.Component))
        : React.createElement('section',{id:'conversation-panel'},
          React.createElement('header',{className:'harness-header'},React.createElement('strong',null,'当前项目会话 · ' + nav.sessionId),React.createElement(header.Component,{sessionId:nav.sessionId})),
          React.createElement('div',{className:'harness-conversation'},'Conversation fixture'))),
      nav.right ? React.createElement('aside',{id:'right-panel',className:'harness-right','data-session-id':nav.sessionId},
        React.createElement('div',{className:'harness-right-title'},React.createElement(title.Component),React.createElement('button',{id:'right-hide',onClick:() => services.sidebarRight.hide('session-tab')},'收起')),
        React.createElement('div',{className:'harness-right-body'},React.createElement(right.Component,{sessionId:nav.sessionId}))) : null);
  }
  ReactDOM.createRoot(document.getElementById('app')).render(React.createElement(HostApp));
  window.__getNavigation = () => ({ panel:nav.panel, right:nav.right, sessionId:nav.sessionId,
    tabs:rightTabs.map((tab) => ({id:tab.id,sessionId:tab.sessionId,kind:tab.kind,visible:tab.visible})) });
  window.__harnessReady = true;
} catch (error) { window.__harnessError = String(error && error.stack || error); throw error; }
`
function htmlFor(installed) {
  const styles = Object.keys(installed.assets).filter((name) => name.endsWith('.css'))
  const entry = Object.keys(installed.assets).find((name) => name.endsWith('.js') && /index-/.test(name))
  if (!entry) throw new Error('安装 dist 缺入口 JS')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>task-22 session UI</title>${styles.map((name) => `<link rel="stylesheet" href="/${name}">`).join('')}<style>${Object.values(installed.themeStyles).join('\n')}</style><style>${HARNESS_CSS}</style><script>${CAPTURE_FACADE}</script></head><body><div id="root"></div><div id="app"></div><script type="module" src="/${entry}"></script><script type="module">${HARNESS_MODULE.replaceAll('</script', '<\\/script')}</script></body></html>`
}

function watcher(repo, sessionId) {
  return { id:`${repo}#${sessionId}`, repo, sessionId, provider:'github', intervalSec:60, enabled:true, observe:false,
    title:sessionId === SESSION_A ? '当前项目 watcher' : '目标项目 watcher', note:'', ackLabel:'主理鱼:已处理',
    filters:{labels:[],ignoreLabels:[],onlyAssigned:false,onlyNewComments:false,assignee:null,allowAuthors:[]},
    priority:{reopened:true,comments:true,labels:true,unassigned:false,stale:false}, history:[],filteredLog:[],events:[] }
}
const fixture = { watchers:[watcher('fixture/current', SESSION_A), watcher('fixture/target', SESSION_B)] }
function stateFor(url) {
  const global = url.searchParams.get('scope') === 'global'
  const sessionId = url.searchParams.get('sessionId')
  const watchers = global ? fixture.watchers : fixture.watchers.filter((item) => item.sessionId === sessionId)
  return { routeBase:'/session-superagent', serverVersion:'1.1.0', runningVersion:'1.1.0', installedVersion:'1.1.0',
    brandName:'主理鱼', sessionTitle:sessionId === SESSION_A ? '当前项目会话' : sessionId === SESSION_B ? '目标项目会话' : null,
    sessionGoal:null, defaults:{sessionMaxWakes:12,maxWakesPerHour:6,isolateKeepDays:3,batchLimit:5},
    credentials:{token:'configured',sshKeyPath:'none'}, gh:{ok:true,version:'fixture'}, watchers }
}
function json(response, status, body) {
  response.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
  response.end(JSON.stringify(body))
}
async function startServer(installed, clientSource) {
  const html = htmlFor(installed)
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const method = request.method || 'GET'
      let body = ''
      for await (const chunk of request) body += chunk
      if (url.pathname.startsWith('/session-superagent')) apiLog.push({method,path:url.pathname + url.search,body})
      if (method === 'GET' && url.pathname === '/session-superagent/state') return json(response, 200, stateFor(url))
      if (method === 'GET' && url.pathname === '/session-superagent/update') return json(response, 200, {current:'1.1.0',latest:'1.1.0',hasUpdate:false})
      if (method === 'GET' && url.pathname === '/session-superagent/client-note') return json(response, 200, {ok:true})
      if (method === 'POST' && url.pathname === '/session-superagent/watch') {
        const next = JSON.parse(body || '{}')
        if (!next.repo || ![SESSION_A,SESSION_B].includes(next.sessionId)) return json(response, 400, {error:'fixture 新建需要有效 repo/sessionId'})
        let entry = fixture.watchers.find((item) => item.repo === next.repo && item.sessionId === next.sessionId)
        if (!entry) { entry = watcher(next.repo, next.sessionId); fixture.watchers.push(entry) }
        return json(response, 200, {ok:true,id:entry.id,warnings:[]})
      }
      if (url.pathname.startsWith('/session-superagent/') && method !== 'GET') return json(response, 403, {error:'fixture 未允许此写操作'})
      if (url.pathname === '/') { response.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'}); return response.end(html) }
      if (url.pathname === '/client.js') { response.writeHead(200, {'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}); return response.end(clientSource) }
      const asset = installed.assets[url.pathname.slice(1)]
      if (asset) { response.writeHead(200, {'content-type':url.pathname.endsWith('.css') ? 'text/css; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'}); return response.end(asset.body) }
      return json(response, 404, {error:'not found'})
    } catch (error) { return json(response, 500, {error:String(error && error.message || error)}) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, origin:`http://127.0.0.1:${server.address().port}` }
}

const installed = loadInstalledAssets()
const repoPackage = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(REPO, 'client.js'), 'utf8')
const clientSha256 = sha256(clientSource)
const scriptSha256 = sha256(readFileSync(join(REPO, 'scripts', 'verify-session-ui-chromium.mjs')))
const { server, origin } = await startServer(installed, clientSource)
const task = await taskSpace(SPACE_NAME)
const page = task.page('p1')
let chromium = 'unknown'
async function shot(name) {
  const path = join(ARTIFACTS, name + '.png')
  await page.screenshot({ path, fullPage:false })
  const bytes = readFileSync(path).length
  if (bytes <= 0) throw new Error('空截图：' + path)
  screenshots.push({name,path,bytes,sha256:sha256(readFileSync(path))})
  console.log('SCREENSHOT ' + path + ' bytes=' + bytes)
}
async function theme(dark) {
  await page.evaluate((value) => {
    if (value) document.body.setAttribute('data-ds-dark-theme','true')
    else document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = value ? 'dark' : 'light'
  }, dark)
  // 主题 token 立即变化，但官方 SegmentedTabs 的 color/indicator 有过渡；等待真实动画完成，
  // 不能用固定毫秒把半浅半深的中间帧当成产品稳态缺陷。
  await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll("[role='tablist']")]
      .flatMap((root) => [root, ...root.querySelectorAll('*')])
    const animations = nodes.flatMap((node) => node.getAnimations())
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
  })
}
async function openGlobal() {
  await page.click('#nav-global')
  await page.waitForFunction(() => document.querySelector('#global-panel .dt-page h1')?.textContent === '主理鱼'
    && !document.querySelector('#global-panel')?.innerText.includes('正在读取…'), undefined, {timeout:15000})
}
async function openRight() {
  await page.click("button[aria-label='本会话的主理鱼']")
  await page.waitForFunction(() => document.querySelector('#right-panel .dt-page h1')?.textContent === '主理鱼'
    && !document.querySelector('#right-panel')?.innerText.includes('正在读取…'), undefined, {timeout:15000})
}
async function measure(selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel)
    return { viewport:innerWidth, documentOverflow:document.documentElement.scrollWidth > innerWidth + 1,
      rootOverflow:node ? node.scrollWidth > node.clientWidth + 1 : null,
      clientWidth:node?.clientWidth, scrollWidth:node?.scrollWidth }
  }, selector)
}
async function inspectTabs(container) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel + " [role='tab']")].map((node) => {
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(node)
    const textRect = range.getBoundingClientRect()
    const x = textRect.left + textRect.width / 2
    const y = textRect.top + textRect.height / 2
    const hit = textRect.width > 0 && textRect.height > 0 ? document.elementFromPoint(x, y) : null
    const styleKeys = ['color','backgroundColor','display','visibility','opacity','overflow','fontSize','fontWeight','textIndent','clipPath','filter','mixBlendMode','transform','zIndex','boxShadow','webkitTextFillColor','webkitTextStrokeColor']
    const pseudo = ['::before','::after'].map((name) => {
      const value = getComputedStyle(node, name)
      return {name,content:value.content,style:Object.fromEntries(styleKeys.map((key) => [key,value[key]]))}
    })
    const ancestors = []
    for (let parent = node.parentElement; parent && ancestors.length < 4; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent)
      ancestors.push({tag:parent.tagName,id:parent.id,class:parent.getAttribute('class'),
        style:Object.fromEntries(styleKeys.map((key) => [key,parentStyle[key]])),
        pseudo:['::before','::after'].map((name) => {
          const value = getComputedStyle(parent, name)
          return {name,content:value.content,style:Object.fromEntries(styleKeys.map((key) => [key,value[key]]))}
        })})
    }
    const matchedRules = []
    if (node.getAttribute('aria-selected') === 'true') {
      const visit = (rules, conditions = []) => {
        for (const rule of rules) {
          if (rule.selectorText) {
            let matches = false
            try { matches = node.matches(rule.selectorText) } catch {}
            if (matches) matchedRules.push({selector:rule.selectorText,conditions,cssText:rule.cssText})
          }
          if (rule.cssRules) visit(rule.cssRules, [...conditions, rule.conditionText || rule.name || rule.type])
        }
      }
      for (const sheet of document.styleSheets) {
        try { visit(sheet.cssRules) } catch {}
      }
    }
    return {
      id:node.id, text:node.textContent, selected:node.getAttribute('aria-selected'), html:node.outerHTML,
      rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      textRect:{x:textRect.x,y:textRect.y,width:textRect.width,height:textRect.height},
      style:Object.fromEntries(styleKeys.map((key) => [key,style[key]])),
      hit:hit ? {tag:hit.tagName,id:hit.id,class:hit.getAttribute('class'),text:hit.textContent} : null,
      pseudo, ancestors, matchedRules,
      children:[...node.children].map((child) => {
        const childStyle = getComputedStyle(child)
        const childRect = child.getBoundingClientRect()
        return {tag:child.tagName,class:child.getAttribute('class'),text:child.textContent,
          rect:{x:childRect.x,y:childRect.y,width:childRect.width,height:childRect.height},
          style:Object.fromEntries(styleKeys.map((key) => [key,childStyle[key]]))}
      }),
    }
  }), container)
}
async function waitHeader(pressed) {
  await page.waitForFunction((expected) => {
    const button = document.querySelector("button[aria-label='本会话的主理鱼']")
    return button?.getAttribute('aria-pressed') === String(expected)
      && Boolean(document.querySelector('#right-panel')) === expected
  }, pressed, {timeout:10000})
}
async function exerciseTabs(container) {
  const sequence = [
    ['ArrowRight','sa-main-tab-judge'], ['ArrowLeft','sa-main-tab-overview'],
    ['End','sa-main-tab-settings'], ['Home','sa-main-tab-overview'],
    ['ArrowLeft','sa-main-tab-settings'], ['ArrowRight','sa-main-tab-overview'],
  ]
  await page.focus(container + ' #sa-main-tab-overview')
  const actual = []
  for (const [key,id] of sequence) {
    await page.keyboard.press(key)
    await page.waitForFunction(({root,expected}) => document.activeElement?.id === expected
      && document.querySelector(root + ' #' + expected)?.getAttribute('aria-selected') === 'true',
    {root:container,expected:id}, {timeout:6000})
    actual.push([key,await page.evaluate(() => document.activeElement?.id)])
  }
  check(container + ' tabs ArrowLeft/ArrowRight/Home/End 与焦点跟随', true, actual)
}
async function tabVisibility(container) {
  return page.evaluate((root) => {
    const selected = document.querySelector(root + " [role='tab'][aria-selected='true']")
    if (!selected) return {missing:true}
    const range = document.createRange()
    range.selectNodeContents(selected)
    const rect = range.getBoundingClientRect()
    const style = getComputedStyle(selected)
    const probe = document.createElement('span')
    probe.style.color = 'var(--dsw-alias-label-primary)'
    document.body.appendChild(probe)
    const expectedColor = getComputedStyle(probe).color
    probe.remove()
    const indicator = [...selected.parentElement.children].find((node) => String(node.className).includes('indicator'))
    return {
      id:selected.id,text:selected.textContent,rect:{width:rect.width,height:rect.height},
      color:style.color,textFill:style.webkitTextFillColor,expectedColor,
      visibility:style.visibility,opacity:style.opacity,
      indicatorBackground:indicator ? getComputedStyle(indicator).backgroundColor : null,
    }
  }, container)
}

try {
  await page.cdp('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  try {
    const info = await page.cdp('Browser.getWindowForTarget', {})
    await page.cdp('Browser.setWindowBounds', {windowId:info.windowId,bounds:{windowState:'normal',left:-10000,top:-10000,width:1440,height:1000}})
    observe('浏览器窗口已移出屏幕', {left:-10000,top:-10000})
  } catch (error) { observe('窗口离屏不可用；仍保持单 Page', String(error && error.message || error)) }
  await page.goto(origin)
  await page.waitForFunction(() => window.__harnessReady === true || window.__harnessError, undefined, {timeout:25000})
  const harnessError = await page.evaluate(() => window.__harnessError || null)
  if (harnessError) throw new Error(harnessError)
  await page.waitForSelector("button[aria-label='本会话的主理鱼']", {state:'visible',timeout:15000})
  const browser = await page.evaluate(async () => ({userAgent:navigator.userAgent,highEntropy:navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList']) : null}))
  chromium = browser.highEntropy?.fullVersionList?.find((item) => item.brand === 'Chromium')?.version || browser.userAgent.match(/Chrome\/([^ ]+)/)?.[1] || 'unknown'
  check('真实 Chromium 与真实 client.js 已加载', /^\d+\./.test(chromium), {chromium,origin})

  const registration = await page.evaluate(() => ({
    keys:Object.keys(window.__registrations),
    definitions:window.__definitions.map((item) => ({id:item.id,kind:item.kind,guide:item.guide?.length})),
    headerText:document.querySelector("button[aria-label='本会话的主理鱼']")?.textContent || '',
    headerSvg:Boolean(document.querySelector("button[aria-label='本会话的主理鱼'] svg")),
  }))
  check('左侧全局页、头部图标与右栏 definition 注册完整', ['main#session-superagent','sidebar.panellist#session-superagent','sidebar.right.pane.tab#dsh-session-superagent/session','sidebar.right.pane.tab.title#dsh-session-superagent/session','conversation.session.header.utilities#session-superagent-current'].every((key) => registration.keys.includes(key))
    && registration.definitions.some((item) => item.id === 'dsh-session-superagent/session' && item.kind === RIGHT_KIND && item.guide === 1)
    && registration.headerText === '' && registration.headerSvg, registration)
  check('旧 session-superagent-desk/conversation.view 中栏缺席', !registration.keys.includes('conversation.view#session-superagent-desk'), registration.keys)

  const headerSelector = "button[aria-label='本会话的主理鱼']"
  const initialHeader = await page.evaluate((selector) => ({
    pressed:document.querySelector(selector)?.getAttribute('aria-pressed'),
    title:document.querySelector(selector)?.getAttribute('title'),
  }), headerSelector)
  check('头部初始 aria-pressed=false 且官方 Tooltip 路径无 title', initialHeader.pressed === 'false' && initialHeader.title === null, initialHeader)
  let tooltipOpened = false
  let tooltipDiagnostic = null
  try {
    await page.hover(headerSelector, {label:'查看头部官方 Tooltip'})
    await page.waitForFunction((selector) => {
      const trigger = document.querySelector(selector)
      const id = trigger?.getAttribute('aria-describedby')
      const described = id ? document.getElementById(id) : null
      const candidates = [...document.querySelectorAll("[role='tooltip'], [data-pinned]")]
      const bubble = described || candidates.find((node) => node.textContent?.trim() === '本会话的主理鱼')
      const style = bubble ? getComputedStyle(bubble) : null
      return Boolean(bubble && style.display !== 'none' && style.visibility === 'visible')
    }, headerSelector, {timeout:3000})
    tooltipOpened = true
  } catch (error) {
    tooltipDiagnostic = await page.evaluate(({selector,message}) => ({
      trigger:document.querySelector(selector)?.outerHTML,
      active:document.activeElement?.outerHTML,
      describedBy:document.querySelector(selector)?.getAttribute('aria-describedby'),
      candidates:[...document.querySelectorAll("[role='tooltip'], [data-pinned]")].map((node) => node.outerHTML),
      bodyTail:document.body.innerHTML.slice(-3000),
      error:message,
    }), {selector:headerSelector,message:String(error && error.message || error)})
  }
  check('头部 hover 显示安装版 DSH Tooltip', tooltipOpened, tooltipDiagnostic)
  observe('头部 Tooltip 真实 DOM', tooltipDiagnostic || {opened:true})
  let tooltipDismissed = false
  if (tooltipOpened) {
    // 与既有官方 Tooltip 验收一致：click pin 后移出仍应保持，再验证 Escape 真正关闭。
    await page.click(headerSelector)
    await waitHeader(true)
    await page.mouse.move(20, 200, {label:'移出已固定头部 Tooltip'})
    await page.keyboard.press('Escape')
    try {
      await page.waitForFunction((selector) => {
        const trigger = document.querySelector(selector)
        const id = trigger?.getAttribute('aria-describedby')
        const described = id ? document.getElementById(id) : null
        const candidates = [...document.querySelectorAll("[role='tooltip'], [data-pinned]")]
        const bubble = described || candidates.find((node) => node.textContent?.trim() === '本会话的主理鱼')
        if (!bubble) return true
        const style = getComputedStyle(bubble)
        return style.display === 'none' || style.visibility !== 'visible'
      }, headerSelector, {timeout:3000})
      tooltipDismissed = true
    } catch {}
  }
  check('头部 Tooltip Escape 键盘关闭', tooltipDismissed)
  if (await page.evaluate(() => Boolean(document.querySelector('#right-hide')))) {
    await page.click('#right-hide')
    await waitHeader(false)
  }
  // Tooltip pin/Escape 的 open/hide 已独立验证；清零 fixture 调用，隔离后面的 Enter/Space 计数。
  await page.evaluate(() => {
    window.__navigationCalls.openTab.length = 0
    window.__navigationCalls.hide.length = 0
  })

  await page.focus(headerSelector)
  const keyboardHeader = []
  for (const [key,pressed] of [['Enter',true],['Enter',false],['Space',true],['Space',false]]) {
    await page.keyboard.press(key)
    await waitHeader(pressed)
    keyboardHeader.push([key,pressed])
  }
  const headerCalls = await page.evaluate(() => window.__navigationCalls)
  check('头部 Enter/Space 开关与二次 hide 都同步 aria-pressed', headerCalls.openTab.length === 2
    && JSON.stringify(headerCalls.hide) === JSON.stringify(['session-tab','session-tab']), {keyboardHeader,headerCalls})

  await openRight()
  const right = await page.evaluate(() => ({sessionId:document.querySelector('#right-panel')?.getAttribute('data-session-id'),
    repos:[...document.querySelectorAll('#right-panel .dt-open')].map((node) => node.textContent),
    text:document.querySelector('#right-panel .dt-page-head')?.innerText,
    calls:window.__navigationCalls.openTab}))
  const rightReads = apiLog.filter((row) => row.method === 'GET' && row.path.startsWith('/session-superagent/state'))
  check('头部真实点击打开右栏且仅读取当前 session-a', right.sessionId === SESSION_A
    && JSON.stringify(right.repos) === JSON.stringify(['fixture/current'])
    && right.text?.includes('当前项目会话') && right.calls.every((args) => JSON.stringify(args) === JSON.stringify([RIGHT_KIND]))
    && rightReads.some((row) => row.path === '/session-superagent/state?sessionId=session-a')
    && !rightReads.some((row) => row.path.includes('scope=global')), {right,rightReads})

  await page.click('#right-hide')
  await openGlobal()
  const globalReadStart = apiLog.length
  await page.evaluate(() => [...document.querySelectorAll("#global-panel [role='tab']")].find((node) => node.textContent === '触发')?.scrollIntoView({block:'center',inline:'nearest'}))
  await page.focus("#global-panel [role='tab']:text-is(\"触发\")")
  await page.keyboard.press('Enter')
  await page.selectOption("#global-panel select[aria-label='目标会话']", SESSION_B)
  await page.fill('#global-panel #watcher-new-repo', 'fixture/from-global')
  await page.evaluate(() => document.querySelector("#global-panel button[aria-label='添加到所选会话']")?.scrollIntoView({block:'center',inline:'nearest'}))
  await page.focus("#global-panel button[aria-label='添加到所选会话']")
  await page.keyboard.press('Enter')
  const created = await waitFor(() => apiLog.find((row) => row.method === 'POST' && row.path === '/session-superagent/watch' && row.body.includes('fixture/from-global')))
  await page.waitForFunction(() => document.querySelector('#global-panel #watcher-new-repo')?.value === '', undefined, {timeout:6000})
  const globalReads = apiLog.slice(globalReadStart).filter((row) => row.method === 'GET' && row.path.startsWith('/session-superagent/state'))
  const createBody = JSON.parse(created.body)
  check('全局新建可选择 session-b 且读取不被改成会话 scope', createBody.repo === 'fixture/from-global' && createBody.sessionId === SESSION_B
    && globalReads.every((row) => row.path === '/session-superagent/state?scope=global'), {createBody,globalReads})

  // 提交后焦点在表单底部；用真实键盘激活 tab，避免离屏窗口下鼠标可见性等待造成假失败。
  await page.evaluate(() => [...document.querySelectorAll("#global-panel [role='tab']")].find((node) => node.textContent === '总览')?.scrollIntoView({block:'center',inline:'nearest'}))
  await page.focus("#global-panel [role='tab']:text-is(\"总览\")")
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('#global-panel .dt-open')].some((node) => node.textContent === 'fixture/from-global'), undefined, {timeout:6000})
  await theme(false); await shot('global-light')
  await theme(true); await shot('global-dark')

  await page.click('#nav-conversation')
  await openRight()
  const currentAfterGlobal = await page.evaluate(() => ({sessionId:document.querySelector('#right-panel')?.getAttribute('data-session-id'),
    repos:[...document.querySelectorAll('#right-panel .dt-open')].map((node) => node.textContent)}))
  check('全局目标选择不会改变右栏当前 session', currentAfterGlobal.sessionId === SESSION_A
    && JSON.stringify(currentAfterGlobal.repos) === JSON.stringify(['fixture/current']), currentAfterGlobal)
  await theme(false); await shot('session-light')
  await theme(true); await shot('session-dark')

  await page.cdp('Emulation.setDeviceMetricsOverride', {width:700,height:1000,deviceScaleFactor:1,mobile:false})
  await page.click('#right-hide'); await openGlobal()
  await exerciseTabs('#global-panel')
  await page.click('#nav-conversation'); await openRight()
  await exerciseTabs('#right-panel')

  for (const container of ['global','session']) {
    if (container === 'global') {
      await page.click('#right-hide'); await openGlobal()
    } else {
      await page.click('#nav-conversation'); await openRight()
    }
    const root = container === 'global' ? '#global-panel' : '#right-panel'
    for (const dark of [false,true]) {
      await theme(dark)
      const layout = await measure(root + ' .dt-page')
      const selected = await tabVisibility(root)
      const visible = !selected.missing && selected.text?.trim() && selected.rect.width > 0 && selected.rect.height > 0
        && selected.visibility === 'visible' && selected.opacity === '1'
        && selected.color === selected.expectedColor && selected.textFill === selected.expectedColor
      check('700px ' + container + ' ' + (dark ? 'dark' : 'light') + ' 当前页签可见且无横向溢出',
        layout.viewport === 700 && layout.documentOverflow === false && layout.rootOverflow === false && Boolean(visible),
        {layout,selected})
      const name = container + '-700-' + (dark ? 'dark' : 'light')
      if (container === 'session' && dark) observe('700px 深色右栏页签 DOM/computed style（动画完成后）', await inspectTabs(root))
      await shot(name)
    }
  }

  const pageErrors = await page.evaluate(() => ({errors:window.__captureErrors,network:window.__networkViolations,navigation:window.__getNavigation(),calls:window.__navigationCalls}))
  check('无浏览器运行错误或外部网络请求', pageErrors.errors.length === 0 && pageErrors.network.length === 0, pageErrors)
  check('双主题与 700px 两容器完整截图矩阵齐全', ['global-light','global-dark','session-light','session-dark',
    'global-700-light','global-700-dark','session-700-light','session-700-dark'].every((name) => screenshots.some((item) => item.name === name)), screenshots)
} catch (error) {
  console.error('VERIFY_ERROR', error)
  check('脚本执行完成', false, String(error && error.stack || error))
  try {
    const last = await page.evaluate(() => ({ready:window.__harnessReady,error:window.__harnessError || null,errors:window.__captureErrors,body:document.body.innerText.slice(0,5000)}))
    writeFileSync(join(ARTIFACTS, 'last-page.json'), JSON.stringify(last, null, 2))
    console.error('LAST_PAGE ' + JSON.stringify(last))
  } catch {}
  process.exitCode = 1
} finally {
  if (results.some((row) => !row.pass)) process.exitCode = 1
  const summary = {task:'task-28',passed:results.filter((row) => row.pass).length,failed:results.filter((row) => !row.pass).length,
    total:results.length,failedNames:results.filter((row) => !row.pass).map((row) => row.name),exitCode:process.exitCode || 0,
    chromium,repo:REPO,repoVersion:repoPackage.version,clientSha256,scriptSha256,frontendVersion:installed.frontendVersion,
    asar:ASAR,asarSha256:installed.asarSha256,installSource:INSTALL.source,artifacts:ARTIFACTS,screenshots,observations,
    checks:results,unverified:['宿主 slot/导航服务和 HTTP API 为仿真 fixture；不是实际 DSH WebView 或真实仓库写操作。','真实宿主 DockKit chrome、读屏、触摸、IME 与用户整版确认不在本脚本证据范围内；编辑/暂停/删除/Ticket/Outbox/草稿复用既有 verify-panel-chromium 结果。']}
  writeFileSync(join(ARTIFACTS, 'summary.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(ARTIFACTS, 'api.json'), JSON.stringify(apiLog, null, 2))
  console.log('SUMMARY ' + JSON.stringify({passed:summary.passed,failed:summary.failed,total:summary.total,failedNames:summary.failedNames,exitCode:summary.exitCode,artifacts:ARTIFACTS,screenshots:screenshots.map((item) => item.path)}))
  const closing = new Promise((resolve) => server.close(resolve))
  server.closeAllConnections?.()
  await closing
}
