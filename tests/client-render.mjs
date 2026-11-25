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

// ---- mock fetch ----
globalThis.fetch = dom.window.fetch = async (url) => {
  if (String(url).includes('/status')) {
    return {
      ok: true,
      json: async () => ({
        config: { enabled: true, style: 'playful', customPrompt: '', provider: 'auto', model: 'auto' },
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
  if (String(url).includes('/generations')) {
    return {
      ok: true,
      json: async () => ({
        generations: [{
          ts: Date.now(), session: 's1', turn: 1, style: 'playful',
          // 会话日志定位坐标（host 在 record 落盘后回填）
          step: 8, messageId: 'quip-s1-1-8-abc', recordSeq: 105, afterSeq: 102, turnEndSeq: 104,
          provider: 'zai-coding-cn', model: 'glm-5.3-flash',
           material: '素材正文', systemPrompt: '系统提示词',
          // 一个 text 字段 = 用户最终看到的那句（模型原文或兜底句），来源看 source；file = 所属记录文件
          text: '（叉腰）稳了', file: 'generations-20261124-172100.jsonl', source: 'model',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          durationMs: 800, error: null,
        }],
      }),
    }
  }
  if (String(url).includes('/quips')) {
    // s-empty / s-stale：该轮没有俏皮话（等待态与历史轮次场景）
    if (/session=s-(empty|stale)/.test(String(url))) {
      return { ok: true, json: async () => ({ quips: [] }) }
    }
    // s-fallback：v2 兜底句——message.source 是插件 producer kind（不挂模型），
    // 尝试过的路由只在 request 里；悬停明细要标出「兜底池」并仍显示那次路由
    if (/session=s-fallback/.test(String(url))) {
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

  // 点开一条记录详情（素材 / 原始输出）
  const row = container.querySelector('.qp-gen-row')
  assert.ok(row !== null, 'generation row exists')
  await actFn(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
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

console.log('client jsdom render smoke: ALL OK')
process.exit(0)
