/**
 * Client 半边的 jsdom 真渲染冒烟：真实 client render（含异步 fetch、状态
 * 更新与重渲染），覆盖设置卡「控件态」与生成记录面板——崩溃（设置卡空白
 * 类 bug）会以 React 错误直接抛出。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const require = createRequire(import.meta.url)
const React = require('react')
const { createRoot } = require('react-dom/client')
const actUtils = require('react-dom/test-utils')
const actFn = typeof React.act === 'function' ? React.act : actUtils.act

// ---- jsdom 全局 ----
const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:65412/' })
globalThis.window = dom.window
globalThis.document = dom.window.document

// ---- 捕获 ModuleLoader ----
let loaded = null
dom.window.__ModuleLoader__ = {
  load(def) { loaded = def },
}

// ---- mock fetch：区分 /status、列表 /generations、单条 /generations?ts=、POST /config，并记录每次请求 ----
const fetchCalls = []
const postBodies = []
// 固定 ts：列表与单条返回的必须是同一条记录（Date.now() 每次调用不同会对不上）。
// 取本地时间 2026-09-05 08:07——月、日、时、分都小于 10，时间列的补零漏了就会露馅
const recordTs = new Date(2026, 8, 5, 8, 7).getTime()
const rawText = '  （叉腰）稳了\n'
const reasoningText = '先想想这轮干了啥'
// 列表记录：新契约不再带 material / systemPrompt 大字段，改为四个字数
const listRecord = {
  ts: recordTs, session: 's1', turn: 1, style: 'playful',
  // 会话日志定位坐标（host 在 record 落盘后回填）
  step: 8, messageId: 'quip-s1-1-8-abc', recordSeq: 105, afterSeq: 102, turnEndSeq: 104,
  provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'low',
  // 一个 text 字段 = 用户最终看到的那句（模型原文或兜底句），来源看 source；file = 所属记录文件
  text: '（叉腰）稳了', file: 'generations-20261124-172100.jsonl', source: 'model',
  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  durationMs: 800, error: null,
  materialChars: '素材正文'.length, systemPromptChars: '系统提示词'.length,
  rawTextChars: rawText.length, reasoningTextChars: reasoningText.length,
}
// 完整记录 = 列表那条 + 全文与新字段（单条 ?ts= 请求返回）
const fullRecord = {
  ...listRecord,
  material: '素材正文', systemPrompt: '系统提示词',
  rawText, reasoningText,
  finishKind: 'stop', failure: null, replayState: null,
  chunks: 12, timedOut: false, timeoutMs: 120000, turnReason: 'completed',
  timing: { routeMs: 3, rebuildMs: null, firstChunkMs: 210, firstTextMs: 480, streamMs: 790, persistMs: 2 },
  configuredReasoningEffort: 'auto', effortsOffered: ['low', 'high'], providerDefaultEffort: 'high',
  modelContextWindow: 128000, modelDefaultMaxTokens: 8192,
  maxChars: 64, includeReasoning: true, fallbackEnabled: true,
  redacted: true, pluginVersion: '0.1.0', hostVersion: '0.2.2-rc.5',
}
// 故障注入：只让下一次对应请求失败（各场景块置位，消费一次自动复位）
let failListOnce = false
let failDetailOnce = false
// 竞态钩子：非 null 时下一次带 ts= 的单条请求挂起（json() 等待手动 resolve），只挂一次
let staleDetailPromise = null
let staleDetailServed = false

globalThis.fetch = dom.window.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/status')) {
    fetchCalls.push(target)
    return {
      ok: true,
      json: async () => ({
        config: { enabled: true, style: 'playful', customPrompt: '', provider: 'auto', model: 'auto', timeoutSeconds: 120, redact: true },
        providers: [
          { id: 'zai-coding-cn', name: 'Zai', models: [
            { id: 'glm-5.3', name: 'GLM-5.3', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' },
            { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', efforts: [], defaultEffort: null },
          ] },
          { id: 'workbuddy', name: 'WorkBuddy', models: [
            { id: 'hy4flash-free', name: 'Hy4 flash', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
          ] },
        ],
        styles: ['playful', 'hype', 'roast', 'calm', 'custom'],
        // 记录目录的真实路径：面板「打开记录文件夹」把它交给宿主
        dataDir: '/tmp/dsh-quip-test/generations',
      }),
    }
  }
  if (target.includes('/config') && init?.method === 'POST') {
    // 记录保存请求的 body：设置卡测试断言写回的 timeoutSeconds / redact
    fetchCalls.push(target)
    postBodies.push({ url: target, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ config: postBodies[postBodies.length - 1]?.body?.config ?? {} }) }
  }
  if (target.includes('/generations')) {
    fetchCalls.push(target)
    const ts = new URL(target, 'http://127.0.0.1').searchParams.get('ts')
    if (ts !== null) {
      // 单条全文：按 ts 命中才给完整记录（ts 不匹配给空数组，能暴露前端拼错参数）
      if (failDetailOnce) { failDetailOnce = false; return { ok: false, status: 500, json: async () => ({}) } }
      // 竞态钩子：第一次命中即挂起，让测试在它仍「在途」时操作刷新
      if (staleDetailPromise !== null && !staleDetailServed) {
        staleDetailServed = true
        return { ok: true, json: async () => await staleDetailPromise }
      }
      return { ok: true, json: async () => ({ generations: ts === String(recordTs) ? [fullRecord] : [] }) }
    }
    if (failListOnce) { failListOnce = false; return { ok: false, status: 500, json: async () => ({}) } }
    return { ok: true, json: async () => ({ generations: [listRecord] }) }
  }
  if (target.includes('/quips')) {
    // s-empty / s-stale：该轮没有俏皮话（等待态与历史轮次场景）
    if (/session=s-(empty|stale)/.test(target)) {
      return { ok: true, json: async () => ({ quips: [] }) }
    }
    // s-fallback：v2 兜底句——message.source 是插件 producer kind（不挂模型），
    // 尝试过的路由只在 request 里；悬停明细要标出「兜底池」并仍显示那次路由
    if (/session=s-fallback/.test(target)) {
      return {
        ok: true,
        json: async () => ({
          quips: [{
            v: 2, turn: 3, step: 1, attempt: 0,
            text: '（挠头）中间手滑了一下，别在意',
            message: { role: 'assistant', content: [{ type: 'text', text: '（挠头）中间手滑了一下，别在意' }], source: { kind: 'dsh-quip' }, id: 'quip-fb' },
            usage: { inputTokens: 438, outputTokens: 128, totalTokens: 566 },
            request: { provider: 'zai-coding-cn', model: 'glm-5.4', reasoningEffort: 'low', temperature: 1.2 },
            after: { seq: 20, messageId: 'asst-20', turnEndSeq: 22 },
            plugin: { name: 'dsh-quip', source: 'fallback', outcome: 'empty', durationMs: 1400 },
            source: 'fallback', time: Date.now(),
          }],
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({
        quips: [{
          turn: 1, text: '（叉腰）稳了', source: 'model',
          provider: 'zai-coding-cn', model: 'glm-5.3-flash',
          usage: { inputTokens: 10, outputTokens: 2 }, time: Date.now(),
        }],
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}
// EventSource mock：浏览器端订阅通道
class FakeEventSource {
  constructor() { this.readyState = 0; this.onmessage = null; this.onerror = null }
  close() { this.readyState = 2 }
}
globalThis.EventSource = dom.window.EventSource = FakeEventSource

await import(fileURLToPath(new URL('../src/client.js', import.meta.url)))
assert.ok(loaded !== null, 'ModuleLoader captured')

// ---- factory + apply，捕获注册 ----
const moduleExports = loaded.factory(require)
const injected = new Map()
const registered = new Map()
let currentSlotName = ''
// 会话 Remote mock：记录面板「打开记录文件夹」经它在系统文件管理器里打开目录
const openedPaths = []
const mockCtx = {
  effect(setup) { const dispose = setup?.(); return () => dispose?.() },
  remote: {
    session: {
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      openWorkspacePath: async (request) => { openedPaths.push(request); return { ok: true, value: { opened: true } } },
    },
  },
  slots: {
    inject(name, callback) { injected.set(name, callback) },
    register(options, component) { registered.set(`${currentSlotName}:${options.id}`, { options, component }) },
  },
}
moduleExports.apply(mockCtx)
for (const [name, callback] of injected.entries()) { currentSlotName = name; callback() }

const tailEntry = registered.get('conversation.chat.turnTail:dsh-quip')
const settingsEntry = registered.get('settings.section:dsh-quip-settings')
assert.ok(tailEntry, 'tail component registered')
assert.ok(settingsEntry, 'settings component registered')
// 两个槽登记 id 必须不同（同 id 会互相干扰，见 0.2.2 修复）
assert.notEqual(tailEntry.options.id, settingsEntry.options.id, 'tail and settings ids differ')

// ---- 真渲染 turnTail：已有俏皮话 → 显示文本，不显示等待态 ----
{
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => {
    root.render(React.createElement(tailEntry.component, { sessionId: 's1', turn: 1, seq: 10, openFile: () => {} }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const html = container.innerHTML
  assert.ok(container.textContent.includes('（叉腰）稳了'), `tail shows quip: ${container.textContent.slice(0, 160)}`)
  assert.ok(html.includes('data-quip-turn="1"'), 'tail carries turn marker')
  assert.ok(!html.includes('qp-wait'), 'no waiting placeholder once the quip arrived')
  // 旁白风格：不再有气泡图标（竖线由 CSS ::before 画）
  assert.ok(!html.includes('qp-tail-mark'), 'tail has no icon mark')
  root.unmount()
}

// ---- 兜底句渲染：来源标记进 data 属性与悬停明细；尝试过的路由仍可见 ----
{
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const turn3 = { turn: 3, end: { time: Date.now() - 60_000 }, status: 'closed' }
  await actFn(async () => {
    root.render(React.createElement(tailEntry.component, { sessionId: 's-fallback', turn: turn3, seq: 10, openFile: () => {} }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const tail = container.querySelector('.qp-tail')
  assert.ok(tail !== null, 'fallback tail rendered')
  assert.ok(container.textContent.includes('中间手滑了一下'), 'fallback text shown')
  assert.equal(tail.getAttribute('data-quip-source'), 'fallback', 'data-quip-source marks the line as fallback')
  const title = tail.getAttribute('title') ?? ''
  assert.ok(title.includes('兜底池'), 'hover detail names the fallback pool: ' + title)
  assert.ok(title.includes('zai-coding-cn/glm-5.4'), 'hover detail keeps the attempted route: ' + title)
  root.unmount()
}

// ---- 等待态：轮次刚结束、俏皮话还没到 → 显示占位 ----
{
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  // owner props 的 turn 是 TurnLocation 对象：{ turn, end: { time }, status }
  const justEnded = { turn: 2, end: { time: Date.now() }, status: 'closed' }
  await actFn(async () => {
    root.render(React.createElement(tailEntry.component, { sessionId: 's-empty', turn: justEnded, seq: 10, openFile: () => {} }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const html = container.innerHTML
  assert.ok(html.includes('data-quip-waiting="true"'), 'freshly ended turn shows the waiting placeholder')
  assert.equal(container.querySelectorAll('.qp-wait i').length, 3, 'placeholder has three dots')
  // aria-label 不进 textContent，读属性断言无障碍标签
  const waitNode = container.querySelector('[data-quip-waiting="true"]')
  assert.ok(waitNode !== null, 'waiting node found')
  assert.ok((waitNode.getAttribute('aria-label') ?? '').includes('俏皮话'), 'placeholder is labelled for assistive tech')
  root.unmount()
}

// ---- 历史轮次：早已结束且没有俏皮话 → 不占位（翻历史不闪） ----
{
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const longAgo = { turn: 1, end: { time: Date.now() - 60_000 }, status: 'closed' }
  await actFn(async () => {
    root.render(React.createElement(tailEntry.component, { sessionId: 's-stale', turn: longAgo, seq: 10, openFile: () => {} }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(container.innerHTML, '', 'stale turn without a quip renders nothing')
  root.unmount()
}

// ---- 真渲染设置卡：loading → 控件态 → 生成记录展开 ----
{
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => {
    root.render(React.createElement(settingsEntry.component, {}))
  })
  // 等 /status fetch 落地
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const html = container.innerHTML
  assert.ok(html.includes('qp-settings'), 'settings root rendered')
  assert.ok(html.includes('qp-card'), 'settings card rendered')
  // 控件态：风格下拉 + 风格标签
  assert.ok(html.includes('qp-select'), 'selects rendered')
  assert.ok(html.includes('俏皮'), 'style labels rendered')
  // 默认跟随会话模型：固定模型行不出现，模型选项也不渲染
  assert.ok(!html.includes('glm-5.3-flash'), 'fixed model row hidden while following the session')
  const followToggle = container.querySelector('input[aria-label="跟随会话模型"]')
  assert.ok(followToggle !== null, 'follow-session toggle rendered')
  assert.equal(followToggle.checked, true, 'follow-session defaults on')

  // 关掉跟随：固定模型行出现，模型选项可见
  await actFn(async () => { followToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const afterUnfollow = container.innerHTML
  assert.ok(afterUnfollow.includes('glm-5.3-flash'), 'model options rendered once not following')
  // auto 模型时不该出现思考等级下拉（auto 时不知道具体模型，无法定等级）
  assert.equal(container.querySelector('.qp-select--narrow'), null, 'no effort select while the model is auto')

  // 选中声明了思考等级的模型后：等级下拉与模型下拉在同一行，且为窄下拉
  const modelSelect = container.querySelector('.qp-select[aria-label="生成模型"]')
  assert.ok(modelSelect !== null, 'model select found')
  await actFn(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(modelSelect, 'zai-coding-cn/glm-5.3')
    modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const narrow = container.querySelector('.qp-select--narrow')
  assert.ok(narrow !== null, 'reasoning effort select rendered for a model with efforts')
  assert.ok(narrow.closest('.qp-actions')?.querySelector('.qp-select:not(.qp-select--narrow)') !== null, 'reasoning select sits in the model row')
  assert.ok(narrow.textContent.includes('High'), 'effort options rendered')
  assert.equal(narrow.value, 'auto', 'effort defaults to auto')

  // 只有一个思考等级时也要显示（例如 hy4flash-free 只有 high），而不是隐藏
  await actFn(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(container.querySelector('.qp-select[aria-label="生成模型"]'), 'workbuddy/hy4flash-free')
    container.querySelector('.qp-select[aria-label="生成模型"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const single = container.querySelector('.qp-select--narrow')
  assert.ok(single !== null, 'a single reasoning level is still shown, not hidden')
  assert.ok(single.textContent.includes('High'), 'the only level is listed')
  // 收回：切回多等级模型继续后面的断言
  await actFn(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(container.querySelector('.qp-select[aria-label="生成模型"]'), 'zai-coding-cn/glm-5.3')
    container.querySelector('.qp-select[aria-label="生成模型"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  // 切到无等级模型：等级下拉消失，且旧等级被重置为 auto
  await actFn(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(container.querySelector('.qp-select[aria-label="生成模型"]'), 'zai-coding-cn/glm-5.3-flash')
    container.querySelector('.qp-select[aria-label="生成模型"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(container.querySelector('.qp-select--narrow'), null, 'effort select disappears for a model without levels')
  // 切回有等级模型：恢复出现
  await actFn(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(container.querySelector('.qp-select[aria-label="生成模型"]'), 'zai-coding-cn/glm-5.3')
    container.querySelector('.qp-select[aria-label="生成模型"]').dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })

  // 展开生成记录面板：标题行整体是 toggle（jsdom 里没有宿主 primitives，走自绘的 role=button 标题行）
  const toggle = container.querySelector('.qp-gen-head[role="button"]')
  assert.ok(toggle !== null, 'generation toggle row exists')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'toggle row starts collapsed')
  await actFn(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const afterOpen = container.innerHTML
  assert.ok(afterOpen.includes('qp-gen-list'), 'generation list rendered after toggle')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'toggle row reports expanded')
  assert.ok(afterOpen.includes('qp-gen-chevron'), 'self-drawn chevron rendered without host primitives')
  // 刷新模型列表是带文字的按钮，不再是字符图标
  assert.ok([...container.querySelectorAll('button')].some((b) => /刷新|Refresh/.test(b.textContent)), 'refresh is a labelled button')
  assert.ok(afterOpen.includes('（叉腰）稳了'), 'generation record text visible')

  // 点开一条记录详情（素材全文来自单条 ?ts= 请求，点击后等它落地再断言）
  const row = container.querySelector('.qp-gen-row')
  assert.ok(row !== null, 'generation row exists')
  // 时间列带月日（MM-dd HH:mm）：跨天的记录只看时分像乱序；夹具的月、日、时、分都小于 10，验证补零
  assert.equal(row.querySelector('.qp-gen-when')?.textContent ?? '', '09-05 08:07', 'list time column shows MM-dd HH:mm with zero padding')
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const detail = container.innerHTML
  assert.ok(detail.includes('素材正文'), 'record detail expanded')

  // 会话日志定位：详情列出 turn / seq / step / message.id / after 锚点，并给出可复制的定位命令
  const locate = container.querySelector('.qp-gen-locate')
  assert.ok(locate !== null, 'locate block rendered for a record with a session')
  const command = locate.querySelector('.qp-gen-cmd').textContent
  assert.ok(command.includes("-name 's1'"), 'locate command finds the session directory: ' + command)
  assert.ok(command.includes('.seq==105'), 'locate command hits the exact record seq: ' + command)
  assert.ok(command.includes('zstd -dc'), 'locate command decodes the zstd log')
  const copyBtn = locate.querySelector('button[data-copy]')
  assert.ok(copyBtn !== null, 'copy button exists')
  assert.ok(/复制|Copy/.test(copyBtn.textContent), 'copy button is labelled: ' + copyBtn.textContent)
  const detailText = container.querySelector('.qp-gen-detail').textContent
  for (const expected of ['1', '105', '8', 'quip-s1-1-8-abc', '102']) {
    assert.ok(detailText.includes(expected), 'detail shows locate coordinate ' + expected)
  }
  // 合并后的文本字段：详情只有「文本」一项，不再有「结果 / 模型原始输出」两份
  assert.ok(detailText.includes('文本'), 'detail shows the merged text field')
  assert.ok(!detailText.includes('模型原始输出'), 'raw output row is gone')
  assert.ok(!detailText.includes('结果'), 'result row is gone')
  assert.ok(detailText.includes('（叉腰）稳了'), 'detail text is the shown line')
  // 每条记录显示所属文件：行内一处、详情里带完整路径一处
  assert.equal(container.querySelectorAll('.qp-gen-file').length, 1, 'row shows the record file name')
  // 行内只显示时间戳部分（窄面板下省宽度），完整文件名在 hover title 里
  assert.equal(container.querySelector('.qp-gen-file').textContent, '20261124-172100')
  assert.equal(container.querySelector('.qp-gen-file').getAttribute('title'), '/tmp/dsh-quip-test/generations/generations-20261124-172100.jsonl')
  assert.ok(detailText.includes('/tmp/dsh-quip-test/generations/generations-20261124-172100.jsonl'), 'detail shows the full record path')
  // 「打开记录文件夹」：宿主能打开 → 按钮可用；点击把目录路径交给 session Remote（不带 action = 直接进入目录）
  const openBtn = [...container.querySelectorAll('.qp-gen-head-actions .qp-btn')].find((b) => /打开记录文件夹/.test(b.textContent))
  assert.ok(openBtn !== null, 'open-folder button rendered when the panel is open')
  assert.equal(openBtn.disabled, false, 'open-folder button is enabled when the host can open paths')
  await actFn(async () => { openBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.deepEqual(openedPaths, [{ path: '/tmp/dsh-quip-test/generations' }], 'open-folder hands the records dir to session.openWorkspacePath without an action')
  // 保留策略提示：告诉用户不会自动清理、想删就删文件
  assert.ok(/永久保存/.test(container.querySelector('.qp-gen-hint:last-of-type')?.textContent ?? ''), 'retention hint is shown')
  // jsdom 没有 clipboard：点复制应落到「复制失败，请手动选中复制」而不是抛错
  await actFn(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.ok(/复制失败|Copy failed/.test(container.querySelector('.qp-gen-locate button').textContent), 'missing clipboard degrades to a hint')
  root.unmount()
}

// ---- 新契约：展开即请求、单条全文按需缓存、刷新记录、详情新字段、设置卡新控件 ----
{
  fetchCalls.length = 0
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => { root.render(React.createElement(settingsEntry.component, {})) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })

  // 设置卡新控件：超时数字输入（初值来自 /status config）与脱敏开关（默认开）
  const timeoutInput = container.querySelector('input[type="number"][aria-label="生成超时（秒）"]')
  assert.ok(timeoutInput !== null, 'timeout number input rendered')
  assert.equal(timeoutInput.value, '120', 'timeout input reflects the status config')
  assert.equal(timeoutInput.getAttribute('min'), '5', 'timeout input has min=5')
  assert.equal(timeoutInput.getAttribute('max'), '600', 'timeout input has max=600')
  const redactToggle = container.querySelector('input[type="checkbox"][aria-label="素材脱敏"]')
  assert.ok(redactToggle !== null, 'redact toggle rendered')
  assert.equal(redactToggle.checked, true, 'redact toggle defaults on')

  const listCalls = () => fetchCalls.filter((u) => u.includes('/generations') && !u.includes('ts='))
  const detailCalls = () => fetchCalls.filter((u) => u.includes('/generations') && u.includes('ts='))

  // 展开面板：列表请求（不带 ts=）恰好 1 次
  const toggle = container.querySelector('.qp-gen-head[role="button"]')
  assert.ok(toggle !== null, 'generation toggle row exists')
  await actFn(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(listCalls().length, 1, 'first expand requests the list exactly once')

  // 收起再展开：列表请求共 2 次（展开即请求，不再只在首次展开请求）
  await actFn(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(listCalls().length, 2, 'collapse + expand requests the list again')

  // 「刷新记录」按钮在标题行动作区，与「打开记录文件夹」并列
  const refreshRecordsBtn = [...container.querySelectorAll('.qp-gen-head-actions .qp-btn')]
    .find((b) => /刷新记录|Refresh records/.test(b.textContent))
  assert.ok(refreshRecordsBtn !== undefined, 'refresh-records button sits in the head actions')

  // 点开一行：单条全文请求（带 session 与 ts）恰好 1 次，详情渲染全文与新字段
  const row = container.querySelector('.qp-gen-row')
  assert.ok(row !== null, 'generation row exists')
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(detailCalls().length, 1, 'opening a row requests the full record once')
  assert.ok(detailCalls()[0].includes('session=s1'), 'detail request carries the session: ' + detailCalls()[0])
  assert.ok(detailCalls()[0].includes(`ts=${recordTs}`), 'detail request carries the record ts: ' + detailCalls()[0])
  const detailText = container.querySelector('.qp-gen-detail').textContent
  for (const expected of ['素材正文', '先想想这轮干了啥', '（叉腰）稳了', 'auto → low', 'stop', '0.2.2-rc.5', '128000', '已脱敏']) {
    assert.ok(detailText.includes(expected), `full detail shows ${expected}: ${detailText.slice(0, 300)}`)
  }

  // 收起该行再展开：用缓存，单条请求不再增加
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(detailCalls().length, 1, 're-expanding the same row serves the cache')
  assert.ok(container.querySelector('.qp-gen-detail').textContent.includes('素材正文'), 'cached detail still renders the material')

  // 收起该行，点「刷新记录」：列表 +1；再展开该行：单条 +1（缓存已被清空）
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { refreshRecordsBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(listCalls().length, 3, 'refresh records re-requests the list')
  await actFn(async () => { container.querySelector('.qp-gen-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(detailCalls().length, 2, 'cleared cache makes the next expand refetch the full record')

  root.unmount()
}

// ---- 保存设置：POST body 带上 timeoutSeconds 与 redact ----
{
  postBodies.length = 0
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => { root.render(React.createElement(settingsEntry.component, {})) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const saveButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '保存')
  assert.ok(saveButton !== undefined, 'save button found')
  // 超时输入中间态：清空输入框要保留空串（Number('') 是 0，不能把框顶成 0 再出现「05」）
  const timeoutInput = container.querySelector('input[type="number"][aria-label="生成超时（秒）"]')
  assert.ok(timeoutInput !== null, 'timeout input found in the save block')
  // jsdom + react-dom 18.3 下，text input 的 onChange 事件通路（input/change 派发 +
  // value tracker 检测）不生效，而 select/checkbox 通路正常；这里直接调用 React 绑定
  // 的 onChange（等价于 fireEvent，白盒通路），验证处理器的行为而不是平台事件系统
  const propsKey = Object.keys(timeoutInput).find((k) => k.startsWith('__reactProps$'))
  assert.ok(propsKey !== undefined, 'react props bound to the timeout input')
  await actFn(async () => { timeoutInput[propsKey].onChange({ target: { value: '' } }) })
  assert.equal(timeoutInput.value, '', 'cleared timeout input keeps the empty string mid-state')
  // 空串点保存：Number('') || 120 落回默认 120
  await actFn(async () => { saveButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(postBodies.length, 1, 'save POST captured once')
  const sentConfig = postBodies[0]?.body?.config
  assert.equal(sentConfig?.timeoutSeconds, 120, 'save sends timeoutSeconds')
  assert.equal(sentConfig?.redact, true, 'save sends redact')
  root.unmount()
}

// ---- 列表加载失败 → 失败提示；「刷新记录」就是重试 ----
{
  fetchCalls.length = 0
  failListOnce = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => { root.render(React.createElement(settingsEntry.component, {})) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const toggle = container.querySelector('.qp-gen-head[role="button"]')
  await actFn(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.ok(container.textContent.includes('读取失败'), 'failed list load shows the failure hint')
  const refreshRecordsBtn = [...container.querySelectorAll('.qp-gen-head-actions .qp-btn')]
    .find((b) => /刷新记录|Refresh records/.test(b.textContent))
  assert.ok(refreshRecordsBtn !== undefined, 'refresh-records button stays available on failure')
  await actFn(async () => { refreshRecordsBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.ok(container.querySelector('.qp-gen-list') !== null, 'retrying via refresh shows the list again')
  root.unmount()
}

// ---- 单条全文请求失败 → 详情显示失败提示，不抛错；收起再展开即重试 ----
{
  fetchCalls.length = 0
  failDetailOnce = true
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => { root.render(React.createElement(settingsEntry.component, {})) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { container.querySelector('.qp-gen-head[role="button"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const row = container.querySelector('.qp-gen-row')
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.ok(container.querySelector('.qp-gen-detail').textContent.includes('读取失败'), 'failed detail shows the failure hint')
  // 失败不进缓存：收起再展开同一行会重新请求（这次成功）
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.ok(container.querySelector('.qp-gen-detail').textContent.includes('素材正文'), 're-expanding retries and renders the full record')
  root.unmount()
}

// ---- 未脱敏记录：素材块标题变为「未脱敏」 ----
{
  fullRecord.redacted = false
  try {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await actFn(async () => { root.render(React.createElement(settingsEntry.component, {})) })
    await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    await actFn(async () => { container.querySelector('.qp-gen-head[role="button"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    await actFn(async () => { container.querySelector('.qp-gen-row').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
    await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    const detailText = container.querySelector('.qp-gen-detail').textContent
    assert.ok(detailText.includes('素材（未脱敏）'), 'unredacted record labels the material block')
    assert.ok(!detailText.includes('素材（已脱敏）'), 'redacted label is replaced for unredacted records')
    root.unmount()
  } finally {
    fullRecord.redacted = true
  }
}

// ---- 竞态防护：刷新记录后，旧的在途单条响应返回时被代数号丢弃 ----
{
  fetchCalls.length = 0
  staleDetailServed = false
  let releaseStale
  staleDetailPromise = new Promise((resolve) => { releaseStale = resolve })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await actFn(async () => { root.render(React.createElement(settingsEntry.component, {})) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const listCalls = () => fetchCalls.filter((u) => u.includes('/generations') && !u.includes('ts='))
  const detailCalls = () => fetchCalls.filter((u) => u.includes('/generations') && u.includes('ts='))

  await actFn(async () => { container.querySelector('.qp-gen-head[role="button"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })

  // 点开一行：第一次单条请求被钩子挂起（在途），详情显示「读取中」
  const row = container.querySelector('.qp-gen-row')
  assert.ok(row !== null, 'generation row exists')
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(detailCalls().length, 1, 'stale-gated detail request is in flight')
  assert.ok(container.querySelector('.qp-gen-detail').textContent.includes('读取中'), 'detail shows loading while the stale request hangs')

  // 行保持展开，点「刷新记录」：列表 +1；在途标记随代数号一并作废 → 该行立刻重发单条请求（第二次，正常返回）
  const refreshRecordsBtn = [...container.querySelectorAll('.qp-gen-head-actions .qp-btn')]
    .find((b) => /刷新记录|Refresh records/.test(b.textContent))
  assert.ok(refreshRecordsBtn !== undefined, 'refresh-records button rendered')
  await actFn(async () => { refreshRecordsBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(listCalls().length, 2, 'refresh records re-requests the list')
  assert.equal(detailCalls().length, 2, 'refresh invalidates the in-flight marker so the open row refetches')
  assert.ok(container.querySelector('.qp-gen-detail').textContent.includes('素材正文'), 'the fresh response renders the material')

  // 释放第一次旧 promise：携带内容不同的过期假全文
  await actFn(async () => { releaseStale({ generations: [{ ...fullRecord, material: '过期结果' }] }) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  const detailText = container.querySelector('.qp-gen-detail').textContent
  assert.ok(!detailText.includes('过期结果'), 'stale response is dropped by the epoch guard')
  assert.ok(detailText.includes('素材正文'), 'the fresh material stays rendered after the stale one resolves')

  // 收起再展开该行：缓存里是第二次的结果，不再发请求
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  await actFn(async () => { await new Promise((resolve) => setImmediate(resolve)) })
  assert.equal(detailCalls().length, 2, 'cache holds the fresh record; re-expand adds no request')
  assert.ok(container.querySelector('.qp-gen-detail').textContent.includes('素材正文'), 'cached detail keeps the fresh material')

  root.unmount()
  staleDetailPromise = null
}

console.log('client jsdom render smoke: ALL OK')
process.exit(0)
