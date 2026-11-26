/**
 * host 半边的 mock 集成冒烟（不进发布包）。
 *
 * 与旧版的区别：会话日志写入器不再是桩。测试在临时目录里放一个**假的
 * dsh-session 包**，让 `candidateSessionModules → resolveSessionWriter` 真实
 * 走一遍解析与 import；假包的 `appendPluginRecord` 可切换为抛品牌检查错误，
 * 用来验证「写入失败必须可见」这条路径——这正是旧测试全绿而真实写入
 * 三次失败的原因。
 *
 * 夹具使用已安装宿主的对象形状 finish（`reason: { kind, failure? }`）——
 * 宿主协议里不存在字符串 reason 与 chunk 顶层 error 字段。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, pluginRecordOf, isCurrentQuipRecord, textOfRecord, PURGED_RECORD_TYPE, candidateSessionModules, probeHostSessionUrl } from '../src/index.js'
import { SKIP_SENTINEL } from '../src/styles.js'

// ---- 临时目录：假 dsh-session 包 + 生成记录目录 ----
const root = mkdtempSync(join(tmpdir(), 'dsh-quip-test-'))
// 复刻真实布局：<root>/node_modules/@deepseek-ai/{dsh, dsh-session}，DSH_INSTALL_DIR 指向前者。
// createRequire 从 dsh/package.json 解析 '@deepseek-ai/dsh-session' 时向上能找到同级目录。
const scopeDir = join(root, 'node_modules', '@deepseek-ai')
const fakeSessionDir = join(scopeDir, 'dsh-session')
mkdirSync(join(fakeSessionDir, 'lib'), { recursive: true })
writeFileSync(join(fakeSessionDir, 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh-session', type: 'module', main: 'lib/index.js',
  exports: { '.': './lib/index.js' },
}))
writeFileSync(join(fakeSessionDir, 'lib', 'index.js'), [
  'export const calls = []',
  'export const state = { mode: "ok" }',
  'export function appendPluginRecord(session, type, data) {',
  '  calls.push({ session, type, data })',
  '  if (state.mode === "brand") throw new TypeError("Receiver must be an instance of class Session")',
  '  // 与宿主一致：返回记录的日志 seq（调用次数），插件回填到生成记录里用于定位',
  '  return calls.length',
  '}',
].join('\n'))
process.env.DSH_INSTALL_DIR = join(scopeDir, 'dsh')
process.env.QUIP_TIMEOUT_MS = '150'
// index.js 在模块顶层读 QUIP_DATA_DIR，而静态 import 会被提升到这里之前——
// 所以数据目录只能由启动命令传入（见 package.json 的 test 脚本）。这里防御性
// 断言：没设就立即失败，绝不写到真实的 ~/.dsh/quip/。
assert.ok(process.env.QUIP_DATA_DIR, 'QUIP_DATA_DIR must be set by the test runner (refusing to touch ~/.dsh/quip)')
const fakeSession = await import(pathToFileURL(join(fakeSessionDir, 'lib', 'index.js')).href)

// ---- mock ctx ----
const routes = new Map()
const listeners = []
let generatedCalls = []
let streamMode = 'ok'
/** POST /config 走到的编辑函数（fn(current) 的返回值），验证写回路径。 */
const configEdits = []

const okStream = (text) => (async function* () {
  for (const piece of text.match(/./gu) ?? []) {
    yield { type: 'text-delta', index: 0, text: piece }
  }
  yield { type: 'usage', usage: { inputTokens: 321, outputTokens: 12, totalTokens: 333 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

const ctx = {
  llm: {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
    // 精确模型元数据：声明从低到高的思考等级（与真实 adapter 的 efforts 排列一致）。
    // 注意宿主里必须用 resolveModelInfo——resolveModel 是基类占位，永远不带 reasoning。
    resolveModelInfo: async (provider, model) => ({
      provider, id: model, name: model,
      ...(model === 'deepseek-reasoner' ? {
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' },
        // provider 公布的窗口与不传上限时适配器代用的输出上限（生成记录的条件字段）
        context: { contextWindow: 128000 },
        defaultMaxTokens: 8192,
      } : {}),
    }),
    stream: (options) => {
      generatedCalls.push(options)
      if (streamMode === 'hang') {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '半句' }
          await new Promise(() => {}) // 永不结束，等 signal 中止
        })()
      }
      if (streamMode === 'fail') {
        // 失败写在 finish chunk 上（宿主会把适配器异常规范化成 finish，不抛给消费者）
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider down', code: 'PROVIDER_ERROR' } } }
        })()
      }
      if (streamMode === 'empty') {
        // 额度耗尽这类失败的真实形态：流正常结束、零文本、usage 全 0、不抛异常
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
      if (streamMode === 'finishError') {
        // 失败写在 finish chunk 上（adapter 规范化错误），不抛异常
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient quota', code: 'ACCOUNT_QUOTA_EXCEEDED', status: 429 } } }
        })()
      }
      if (streamMode === 'quoted') return okStream('"把引号也当成我的一部分"')
      if (streamMode === 'errorPartial') {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '半句还没说完' }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient quota', code: 'ACCOUNT_QUOTA_EXCEEDED', status: 429 } } }
        })()
      }
      if (streamMode === 'abortedPartial') {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '半句还没说完' }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }
        })()
      }
      if (streamMode === 'maxTokensPartial') {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '撞上限的半句' }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        })()
      }
      if (streamMode === 'errorEmpty') {
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad key', code: 'INVALID_CREDENTIAL', status: 401 } } }
        })()
      }
      if (streamMode === 'noFinishEmpty') {
        // usage 后流直接结束，没有 finish chunk
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 0 } }
        })()
      }
      if (streamMode === 'noFinishText') {
        // 有文本但流直接结束，没有 finish chunk
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '没有终态的一句' }
        })()
      }
      if (streamMode === 'skipOnError') {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: SKIP_SENTINEL }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down', code: 'PROVIDER_ERROR' } } }
        })()
      }
      if (streamMode === 'skipOnStop') {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: SKIP_SENTINEL }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
      if (streamMode === 'reasoning') {
        return (async function* () {
          yield { type: 'reasoning-delta', index: 0, text: '先想想' }
          yield { type: 'text-delta', index: 0, text: '（叉腰）想好了' }
          yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 7, reasoningTokens: 3, cachedTokens: 11 } }
          yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'resp_1' } } }
        })()
      }
      if (streamMode === 'throwsLlmError') {
        // 迭代中途抛出带 failure 的异常（宿主 LlmError 的形状）
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '半句' }
          throw Object.assign(new Error('stream closed'), { failure: { message: 'stream closed', code: 'STREAM_CLOSED' } })
        })()
      }
      if (streamMode === 'throwsPlain') {
        return (async function* () {
          throw new Error('boom')
        })()
      }
      return okStream('（叉腰）这波我自己都觉得很可以')
    },
  },
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
  on: (name, listener) => {
    listeners.push({ name, listener })
    return () => {}
  },
  effect: (setup) => {
    const dispose = setup()
    return () => dispose?.()
  },
  get: (name) => {
    if (name === 'webServer') {
      return {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      }
    }
    if (name === 'sessionQuery') {
      // 冷读与「轮次中途重载后的素材补折」共用：按会话 id 给不同夹具
      return { readSession: async (id) => ({ events: id === 'session-rebuild' ? rebuildEvents : id === 'session-rebuild2' ? rebuildEvents2 : coldLogEvents }) }
    }
    if (name === 'configEditor') {
      // /config 写回：edit 收到 entry 与 fn(current)，fn 的返回值就是新配置
      return { edit: async (_entry, fn) => { configEdits.push(fn(config)) } }
    }
    return undefined
  },
  fiber: { entry: { options: { id: 'quip' } } },
}

// 冷读用的会话日志。结构完整的当前格式应恢复；其他插件的 record、损坏行、缺 ignorable、
// 未来版本、清除历史的占位行全部落选。
const currentRecord = (turn, step, kind, text, pluginExtra = {}) => ({
  v: 1, turn, step,
  message: {
    role: 'assistant', content: [{ type: 'text', text }],
    source: kind === 'model' ? { kind, provider: 'p', model: 'm' } : { kind },
    id: `quip-x-${turn}-${step}`,
  },
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  request: { provider: 'p', model: 'm', temperature: 1.2 },
  after: { seq: 1, messageId: 'a', turnEndSeq: 2 },
  plugin: { name: 'dsh-quip', source: kind === 'model' ? 'model' : 'fallback', outcome: 'ok', ...pluginExtra },
})
const coldLogEvents = [
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'plugin:other/x', seq: 2, time: 2, ignorable: true, data: {} },
  { type: 'plugin:dsh-quip/quip', seq: 3, time: 3, ignorable: true, data: { broken: true } },
  { type: 'plugin:dsh-quip/quip', seq: 4, time: 4, data: currentRecord(9, 1, 'model', '没有 ignorable 标记，不算 record') },
  { type: 'plugin:dsh-quip/quip', seq: 5, time: 5, ignorable: true, data: { ...currentRecord(10, 1, 'model', '未来版本'), v: 99 } },
  // 清除历史时写入的占位行：内容清空、seq 保留
  { type: 'plugin:dsh-quip/purged', seq: 6, time: 6, ignorable: true, data: {} },
  // 当前格式 ×2：模型句 + 兜底句
  { type: 'plugin:dsh-quip/quip', seq: 7, time: 7000, ignorable: true, data: currentRecord(5, 6, 'model', '当前格式的模型句') },
  { type: 'plugin:dsh-quip/quip', seq: 8, time: 8000, ignorable: true, data: currentRecord(7, 1, 'dsh-quip', '当前格式的兜底句', { outcome: 'timeout' }) },
]

// 流程 9 的夹具：补折用的一轮日志，故意不含 turn/end（模拟尚未持久化）
const rebuildEvents = [
  { type: 'turn/start', seq: 20, time: Date.now() - 3000, data: { turn: 5 } },
  { type: 'user/message', seq: 21, time: Date.now() - 3000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '补折轮次的用户发言' }] } },
  { type: 'assistant/message', seq: 28, time: Date.now() - 1000, data: { turn: 5, step: 1, message: { id: 'asst-rebuild', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: '补折轮次的回复' }] } } },
  { type: 'step/end', seq: 28.5, time: Date.now() - 900, data: { turn: 5, step: 3 } },
]

// 流程 10 补折场景的夹具：另一条会话日志，两条各带思考与正文的回复 + 一次工具调用，
// 同样故意不含 turn/end（模拟尚未持久化）。两条非空思考 → 素材里首尾各一行。
const rebuildEvents2 = [
  { type: 'turn/start', seq: 300, time: Date.now() - 2000, data: { turn: 80 } },
  { type: 'assistant/message', seq: 301, time: Date.now() - 1500, data: { turn: 80, step: 1, message: { id: 'asst-rebuild2-a', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'reasoning', text: '补折2第一步的思考' }, { type: 'text', text: '补折2第一步的正文' }] } } },
  { type: 'tool/call', seq: 302, time: Date.now() - 1200, data: { name: 'grep' } },
  { type: 'assistant/message', seq: 303, time: Date.now() - 1000, data: { turn: 80, step: 2, message: { id: 'asst-rebuild2-b', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'reasoning', text: '补折2第二步的思考' }, { type: 'text', text: '补折2第二步的正文' }] } } },
  { type: 'step/end', seq: 304, time: Date.now() - 900, data: { turn: 80, step: 2 } },
]

const config = {
  enabled: true, style: 'playful', customPrompt: '', followSessionModel: false, provider: 'auto', model: 'auto', reasoningEffort: 'auto',
  maxChars: 40, temperature: 1.2, includeInterrupted: false, includeReasoning: true, fallback: true, historyPerSession: 32,
}

// ---- 纯函数单元测试 ----
{
  assert.equal(pluginRecordOf({ type: 'plugin:a/b', ignorable: true, data: {} })?.type, 'plugin:a/b')
  assert.equal(pluginRecordOf({ type: 'plugin:a/b', data: {} }), null, 'missing ignorable → not a record')
  assert.equal(pluginRecordOf({ type: 'turn/end', ignorable: true }), null, 'non-plugin type → not a record')
  assert.equal(pluginRecordOf(null), null)
}
// 纯函数：record 判定与文本提取（不依赖宿主模块实例）
{
  const current = { type: 'plugin:dsh-quip/quip', ignorable: true, data: currentRecord(1, 2, 'model', '当前格式') }
  assert.equal(isCurrentQuipRecord(current), true)
  assert.equal(textOfRecord(current.data), '当前格式')
  // 结构不完整 / 非当前版本 / 占位行都落选
  assert.equal(isCurrentQuipRecord({ ...current, data: { ...current.data, v: 99 } }), false, 'future version is not current')
  assert.equal(isCurrentQuipRecord({ type: PURGED_RECORD_TYPE, ignorable: true, data: {} }), false, 'purged placeholder is not a quip')
  assert.equal(PURGED_RECORD_TYPE, 'plugin:dsh-quip/purged')
  assert.equal(isCurrentQuipRecord({ ...current, ignorable: undefined }), false)
  assert.equal(isCurrentQuipRecord({ ...current, data: { ...current.data, turn: undefined } }), false)
  assert.equal(isCurrentQuipRecord({ ...current, data: { ...current.data, message: { content: 'not-an-array' } } }), false)
  assert.equal(isCurrentQuipRecord(null), false)
  // textOfRecord 只读 message.content 的 text 块
  assert.equal(textOfRecord({ text: '扁平文本' }), '', 'flat text field is not read')
  assert.equal(textOfRecord({ message: { content: [{ type: 'tool-call' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'ab')
  const candidates = candidateSessionModules()
  assert.ok(candidates.length >= 1, 'DSH_INSTALL_DIR yields at least one candidate')
  assert.ok(candidates.some((c) => c.label === 'host-resolve'), 'first candidate uses standard resolution')
  assert.ok(candidates.every((c) => c.url.startsWith('file:')), 'candidates are file URLs')
  // 探测：没有 append 方法的对象返回 null
  assert.equal(probeHostSessionUrl({}), null)
  assert.equal(probeHostSessionUrl(null), null)
}

// ---- 记录目录预置：旧版单文件 + 一个已满 500 条的文件 ----
// 旧版单文件：首条 ts 取 2024-06-01 12:00:00 本地时间，迁移后应命名为 generations-20240601-120000.jsonl；
// 用旧字段 cleaned（最终文本）验证加载时的字段归一化。
const LEGACY_TS = new Date(2024, 5, 1, 12, 0, 0).getTime()
mkdirSync(process.env.QUIP_DATA_DIR, { recursive: true })
writeFileSync(join(process.env.QUIP_DATA_DIR, 'generations.jsonl'),
  JSON.stringify({ ts: LEGACY_TS, session: 'session-legacy', turn: 90001, raw: 'ignored', cleaned: '旧格式的最终文本', source: 'model', maxTokens: 128 }) + '\n')
// 已满的文件：名字要排在迁移文件之后（= 目录里最新），这样下一条记录才会另起新文件
const PREFILL_NAME = 'generations-20250101-000000.jsonl'
mkdirSync(join(process.env.QUIP_DATA_DIR, 'generations'), { recursive: true })
writeFileSync(join(process.env.QUIP_DATA_DIR, 'generations', PREFILL_NAME),
  Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: LEGACY_TS + 100000 + i, session: 'session-prefill', turn: 10000 + i, text: 'prefill ' + i, file: PREFILL_NAME })).join('\n') + '\n')

apply(ctx, config)

// ---- helpers ----
function makeRes() {
  const res = {
    statusCode: 0, headers: {}, body: '', events: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(payload) { this.body = payload ?? '' },
    write(frame) { this.events.push(frame) },
  }
  return res
}
const session = { id: 'session-test-1', header: { origin: null, delegationDepth: 0 } }
const emit = (event, sess = session) => {
  for (const { name, listener } of listeners) {
    if (name === 'session/event') listener(sess, event)
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 取某轮的完整生成记录：列表里按 turn 找到它的 ts，再按 session + ts 取全文。 */
const fullTraceOf = async (turn, sessionId = 'session-test-1') => {
  const list = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=100' }, list)
  const slim = JSON.parse(list.body).generations.find((entry) => entry.turn === turn && entry.session === sessionId)
  if (!slim) return undefined
  const full = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: `/api/quip/v1/generations?session=${encodeURIComponent(sessionId)}&ts=${slim.ts}` }, full)
  return JSON.parse(full.body).generations[0]
}

/** 发一个 POST /config（带 JSON body），返回 { status, body }。 */
const postConfig = async (payload) => {
  const res = makeRes()
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: '/api/quip/v1/config',
    on(event, fn) {
      // body 分片异步喂给 readJsonBody：先 data 后 end
      if (event === 'data') setTimeout(() => fn(body), 0)
      if (event === 'end') setTimeout(fn, 2)
    },
  }
  await routes.get('/api/quip/v1/config').handler(req, res)
  return { status: res.statusCode, body: res.body }
}

// ---- 流程 1：正常生成 + 写入成功 ----
emit({ type: 'turn/start', time: Date.now() - 4000, data: { turn: 1 }, seq: 1 })
emit({ type: 'user/message', time: Date.now() - 4000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修一下登录页' }] }, seq: 2 })
emit({ type: 'assistant/message', time: Date.now() - 2000, data: { turn: 1, step: 1, message: { id: 'asst-msg-1', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [
  { type: 'reasoning', text: '先看 CSS：滚动条颜色被覆盖了……等等，也可能是容器高度；查一下再改。' },
  { type: 'text', text: '已修复滚动条并回归。' },
] } }, seq: 3 })
emit({ type: 'tool/call', time: Date.now() - 3000, data: { name: 'edit' }, seq: 4 })
emit({ type: 'step/end', time: Date.now() - 2500, data: { turn: 1, step: 1 }, seq: 4.1 })
emit({ type: 'step/end', time: Date.now() - 2400, data: { turn: 1, step: 2 }, seq: 4.2 })
emit({ type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } }, seq: 5 })
await wait(120)

assert.equal(generatedCalls.length, 1, 'exactly one llm call')
assert.ok(generatedCalls[0].system.includes('俏皮'), 'system prompt uses playful style')
assert.ok(generatedCalls[0].messages[0].content[0].text.includes('帮我修一下登录页'), 'material carries user text')
// 思考过程进素材：模型内心的犹豫与绕路是自评最贴切的依据
assert.ok(generatedCalls[0].messages[0].content[0].text.includes('也可能是容器高度'), 'material carries reasoning')
assert.ok(generatedCalls[0].messages[0].content[0].text.includes('思考过程'), 'reasoning section is labelled')
assert.ok(generatedCalls[0].system.includes('思考过程'), 'system prompt points at the reasoning')
assert.equal(generatedCalls[0].provider, 'deepseek', 'auto resolves first provider')
assert.equal(generatedCalls[0].sessionId, 'session-test-1')
// 辅助调用的分类必须显式传出；请求层**不设 maxTokens**（长度只靠系统提示约束，
// 硬上限会把带思考的模型在正文出来前截断）；auto 路由无精确 model 时思考等级不传（走 provider 默认）
assert.equal(generatedCalls[0].purpose, 'dsh-quip/generate')
assert.equal(generatedCalls[0].maxTokens, undefined, 'no hard maxTokens on the request')
assert.equal('maxTokens' in generatedCalls[0], false, 'maxTokens is not even present on the request')
assert.ok(generatedCalls[0].system.includes('不超过 40 个字'), 'system prompt carries the hard char limit from maxChars')
assert.ok(generatedCalls[0].system.includes('思考过程、解释、前后缀一律不要写进正文'), 'system prompt keeps reasoning out of the answer')
assert.equal(generatedCalls[0].reasoningEffort, undefined, 'no effort without an exact model')

// 会话日志写入：解析到的写入器来自假包（host-resolve 候选）
assert.equal(fakeSession.calls.length, 1, 'appendPluginRecord called once through resolved writer')
assert.equal(fakeSession.calls[0].session, session, 'writer receives the host session object')
assert.equal(fakeSession.calls[0].type, 'plugin:dsh-quip/quip')
assert.equal(fakeSession.calls[0].data.turn, 1)
assert.deepEqual(fakeSession.calls[0].data.usage, { inputTokens: 321, outputTokens: 12, totalTokens: 333 })
// record 顶层字段集：与 DSH 原生 assistant/message 同构，外加 after 锚点与 plugin 元数据
{
  const data = fakeSession.calls[0].data
  assert.deepEqual(
    Object.keys(data).sort(),
    ['after', 'message', 'plugin', 'request', 'step', 'turn', 'usage', 'v'].sort(),
    'record data mirrors the native assistant/message shape plus the after anchor',
  )
  assert.equal(data.v, 1, 'record format v1')
  // turn/step：quip 挂在本轮最后一步之后——step = 最后一个 step/end（2）+ 1，
  // 占一个主对话永远不会用到的虚拟步，(1, 3) 与本轮任何 assistant/message 都不同槽
  assert.equal(data.turn, 1)
  assert.equal(data.step, 3, 'step is the last step/end of the turn + 1')
  // 没有 attempt。DSH 原生事件没这个字段，quip 不重试；token-usage 的 attempt 是它自己数出来的
  assert.equal('attempt' in data, false, 'no attempt field: DSH has none, quip never retries')
  assert.ok(data.message.id.includes('-1-3-'), 'message id embeds the quip step: ' + data.message.id)
  // message：原生消息体（role/content/source/id）。模型生成 → kind=model 且带 provider/model
  assert.equal(data.message.role, 'assistant')
  assert.deepEqual(data.message.content, [{ type: 'text', text: '（叉腰）这波我自己都觉得很可以' }])
  assert.equal(data.message.source.kind, 'model')
  assert.equal(data.message.source.provider, 'deepseek')
  assert.ok(typeof data.message.id === 'string' && data.message.id !== '', 'message carries an id')
  // usage：原生 TokenUsage
  assert.deepEqual(data.usage, { inputTokens: 321, outputTokens: 12, totalTokens: 333 })
  // request：原生 request/header.header.config 等价物；不设 maxTokens（与请求一致）
  assert.equal(data.request.provider, 'deepseek')
  assert.equal(data.request.temperature, 1.2)
  assert.equal('maxTokens' in data.request, false, 'request carries no maxTokens: length is a prompt constraint')
  // after：这条俏皮话评论的是 seq 3 的那条 assistant/message（id asst-msg-1），直接前驱是 seq 5 的 turn/end
  assert.deepEqual(data.after, { seq: 3, messageId: 'asst-msg-1', turnEndSeq: 5 }, 'after anchors the quip to the reply it comments on')
  // plugin：插件自有元数据，不与原生字段重名
  assert.equal(data.plugin.name, 'dsh-quip')
  assert.equal(data.plugin.purpose, 'dsh-quip/generate')
  assert.equal(data.plugin.source, 'model', 'text came from the model')
  assert.equal(data.plugin.outcome, 'ok', 'model call succeeded')
  assert.equal(data.plugin.routeSource, 'config')
  assert.ok(Number.isFinite(data.plugin.durationMs) && data.plugin.durationMs >= 0)
  // text / provider 不再挂在顶层（它们在 message.content / message.source 里）
  assert.equal('text' in data, false, 'text lives under message.content, not at top level')
  assert.equal('provider' in data, false, 'provider lives under message.source, not at top level')
  assert.equal('model' in data, false, 'model lives under message.source, not at top level')
  assert.equal('session' in data, false, 'no redundant session field')
  assert.equal('ts' in data, false, 'no redundant ts field')
}

// quips 端点
{
  const res = makeRes()
  await routes.get('/api/quip/v1/quips').handler({ url: '/api/quip/v1/quips?session=session-test-1' }, res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.quips.length, 1)
  assert.equal(body.quips[0].text, '（叉腰）这波我自己都觉得很可以')
  assert.equal(body.quips[0].source, 'model')
  // 运行时 entry 在 record 上补 time（刚生成时由插件填），供 client 悬停显示
  assert.ok(Number.isFinite(body.quips[0].time), 'runtime entry carries time')
  assert.equal('ts' in body.quips[0], false, 'runtime entry does not carry legacy ts')
}

// health：写入器已解析、实例比对（探测不到宿主 URL 时为 unverified）、appended 计数
{
  const res = makeRes()
  await routes.get('/api/quip/v1/health').handler({}, res)
  const body = JSON.parse(res.body)
  assert.equal(routes.get('/api/quip/v1/health').auth, 'anonymous', 'health is anonymous for out-of-process diagnostics')
  assert.equal(body.persistence.appended, 1)
  assert.equal(body.persistence.failed, 0)
  assert.equal(body.persistence.writerLabel, 'host-resolve', 'writer resolved via standard resolution candidate')
  // require.resolve 返回 realpath（macOS 上 /var → /private/var）；宿主 ESM loader 同样 realpath，
  // 这正是 host-resolve 候选比直接拼路径更可能命中宿主模块缓存的原因。
  assert.equal(body.persistence.writerUrl, pathToFileURL(realpathSync(join(fakeSessionDir, 'lib', 'index.js'))).href)
  assert.equal(body.persistence.instanceMatch, 'unverified', 'mock session exposes no dsh-session source URL')
  assert.equal(body.persistence.ok, true)
  assert.ok(Array.isArray(body.persistence.candidates) && body.persistence.candidates.length >= 1)
}

// generations 端点：列表瘦身（大字段换成四个字数），点开某条时才按 session + ts 取全文
{
  const res = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=10' }, res)
  const body = JSON.parse(res.body)
  const record = body.generations[0]
  assert.equal(record.source, 'model')
  assert.equal(record.text, '（叉腰）这波我自己都觉得很可以')
  assert.equal('raw' in record, false, 'one text field only')
  // 列表不带五个大字段，改带四个字数
  for (const field of ['material', 'systemPrompt', 'rawText', 'reasoningText', 'replayState']) {
    assert.equal(field in record, false, `list drops the large field ${field}`)
  }
  assert.ok(record.materialChars > 0, 'materialChars hints at the full text')
  assert.ok(record.systemPromptChars > 0, 'systemPromptChars hints at the full prompt')
  assert.equal(record.rawTextChars, record.text.length, 'model output has no surrounding whitespace → raw length equals the shown text')
  assert.equal(record.reasoningTextChars, 0, 'no reasoning chunks this turn')
  // 单条全文：session + ts 定位；ts 查不到时给空数组
  const t1 = await fullTraceOf(1)
  assert.ok(t1, 'full trace of turn 1 retrievable via session + ts')
  assert.ok(t1.material.includes('帮我修一下登录页'), 'full trace carries the material')
  assert.ok(t1.systemPrompt.includes('俏皮'), 'full trace carries the system prompt')
  {
    const miss = makeRes()
    await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?session=session-test-1&ts=1' }, miss)
    assert.deepEqual(JSON.parse(miss.body).generations, [], 'an unknown ts yields an empty list')
  }
  // —— 流程 1 的完整生成记录：新增 trace 字段逐项核对 ——
  assert.equal(t1.rawText, '（叉腰）这波我自己都觉得很可以', 'rawText is the pre-trim model output')
  assert.equal(t1.reasoningText, '', 'no reasoning chunks → empty string')
  assert.equal(typeof t1.timing, 'object')
  assert.deepEqual(Object.keys(t1.timing).sort(), ['firstChunkMs', 'firstTextMs', 'persistMs', 'rebuildMs', 'routeMs', 'streamMs'], 'timing always carries all six keys')
  assert.equal(t1.timing.rebuildMs, null, 'live folding does not rebuild from the session log')
  assert.equal(typeof t1.timing.persistMs, 'number', 'the session log was written')
  assert.equal(typeof t1.timing.firstTextMs, 'number', 'text chunks arrived')
  assert.equal(t1.chunks, t1.text.length + 2, 'okStream yields one chunk per char, plus usage and finish')
  assert.equal(t1.timedOut, false, 'a fast turn does not trip the timeout')
  assert.equal(t1.timeoutMs, 150, 'QUIP_TIMEOUT_MS is the effective threshold')
  assert.equal(t1.turnReason, 'completed', 'the turn/end reason is recorded')
  assert.equal(t1.configuredReasoningEffort, 'auto', 'the pre-resolution configured effort is recorded')
  assert.equal(t1.reasoningEffort, null, 'auto routing without an exact model resolves no effort')
  assert.equal(t1.effortsOffered, null, 'no exact model → no declared efforts')
  assert.equal(t1.providerDefaultEffort, null, 'no exact model → no provider default effort')
  assert.equal('modelContextWindow' in t1, false, 'no model metadata → the key does not exist')
  assert.equal(t1.maxChars, 40, 'maxChars snapshot')
  assert.equal(t1.includeReasoning, true, 'includeReasoning snapshot')
  assert.equal(t1.fallbackEnabled, true, 'fallbackEnabled mirrors the fallback config')
  assert.equal(t1.redacted, true, 'redacted mirrors the redact config')
  assert.equal(t1.pluginVersion, '0.1.0')
  assert.equal(t1.hostVersion, process.env.DSH_CLIENT_VERSION ?? null, 'hostVersion comes from DSH_CLIENT_VERSION, else null')
  assert.equal('maxTokens' in t1, false, 'maxTokens is a dead field: new records never carry it')
}

// 冷读恢复：只认当前格式（v === 1 且带 message.content）
{
  const res = makeRes()
  await routes.get('/api/quip/v1/quips').handler({ url: '/api/quip/v1/quips?session=session-cold-1' }, res)
  const body = JSON.parse(res.body)
  // 夹具里 7 条 plugin:dsh-quip/* 只有 2 条结构完整；purged 占位行、broken、非 ignorable、
  // 未来版本（v99）全部跳过
  assert.equal(body.quips.length, 2, 'only structurally complete records restored')
  assert.equal(body.quips[0].text, '当前格式的模型句')
  assert.equal(body.quips[0].source, 'model')
  assert.equal(body.quips[1].text, '当前格式的兜底句')
  assert.equal(body.quips[1].source, 'fallback')
  assert.equal(body.quips[1].message.source.kind, 'dsh-quip', 'fallback keeps its producer kind through cold read')
  assert.deepEqual(body.quips[1].after, { seq: 1, messageId: 'a', turnEndSeq: 2 }, 'after anchor survives cold read')
  assert.equal(body.quips[1].time, 8000, 'time comes from the outer event envelope')
}

// status 匿名；返回配置 + 每个模型的思考等级元数据（设置卡下拉用）
assert.equal(routes.get('/api/quip/v1/status').auth, 'anonymous')
{
  const res = makeRes()
  await routes.get('/api/quip/v1/status').handler({}, res)
  const body = JSON.parse(res.body)
  assert.equal(body.providers.length, 1)
  assert.deepEqual(body.providers[0].models.map((m) => m.id), ['deepseek-chat', 'deepseek-reasoner'])
  assert.deepEqual(body.providers[0].models[0].efforts, [], 'model without reasoning declares no efforts')
  assert.deepEqual(body.providers[0].models[1].efforts.map((e) => e.id), ['low', 'high', 'max'])
  assert.equal(body.providers[0].models[1].defaultEffort, 'max')
  assert.equal(body.config.style, 'playful')
  assert.equal(body.config.reasoningEffort, 'auto')
}

// ---- 流程 2：品牌检查失败必须可见 ----
fakeSession.state.mode = 'brand'
emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 2 }, seq: 6 })
emit({ type: 'user/message', time: Date.now() - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '再检查下' }] }, seq: 7 })
emit({ type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text: '检查完毕' }] } }, seq: 8 })
emit({ type: 'turn/end', time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } }, seq: 9 })
await wait(120)

assert.equal(fakeSession.calls.length, 2, 'second append attempted (not short-circuited)')
{
  const res = makeRes()
  await routes.get('/api/quip/v1/health').handler({}, res)
  const body = JSON.parse(res.body)
  assert.equal(body.persistence.appended, 1)
  assert.equal(body.persistence.failed, 1, 'brand-check failure counted')
  assert.equal(body.persistence.lastError.name, 'TypeError')
  assert.equal(body.persistence.lastError.message, 'Receiver must be an instance of class Session')
  assert.equal(body.persistence.ok, false, 'health reports not ok after a failed append')
}
// 俏皮话本身仍在内存里（SSE/端点可读），不因持久化失败丢句
{
  const res = makeRes()
  await routes.get('/api/quip/v1/quips').handler({ url: '/api/quip/v1/quips?session=session-test-1' }, res)
  assert.equal(JSON.parse(res.body).quips.length, 2)
}
fakeSession.state.mode = 'ok'

// 写入失败也算「调用过写会话日志」：persistMs 是非负数字，而不是 null
{
  const t2 = await fullTraceOf(2)
  assert.ok(t2, 'turn 2 traced')
  assert.equal(typeof t2.timing.persistMs, 'number', 'persistMs counts even a failed session-log append')
}

// ---- 流程 3：SSE 推送 ----
{
  const res = makeRes()
  const req = { url: '/api/quip/v1/watch?session=session-test-1', on: () => {} }
  routes.get('/api/quip/v1/watch').handler(req, res)
  assert.ok(res.events[0].startsWith('retry:'))
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 3 }, seq: 10 })
  emit({ type: 'user/message', time: Date.now() - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第三轮' }] }, seq: 11 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } }, seq: 12 })
  await wait(120)
  const frames = res.events.filter((frame) => frame.startsWith('data: '))
  assert.equal(frames.length, 1, 'one SSE push for turn 3')
  assert.equal(JSON.parse(frames[0].slice(6)).turn, 3)
}

// ---- 流程 4：开关关闭、error 轮次、子代理 ----
const before = generatedCalls.length
config.enabled = false
emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 4 }, seq: 13 })
emit({ type: 'turn/end', time: Date.now(), data: { turn: 4, reason: { kind: 'completed' } }, seq: 14 })
await wait(30)
config.enabled = true
emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 5 }, seq: 15 })
emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, seq: 16 })
emit({ type: 'turn/end', time: Date.now(), data: { turn: 5, reason: { kind: 'error' } }, seq: 17 })
await wait(30)
const sub = { id: 'child-1', header: { origin: 'subagent', delegationDepth: 1 } }
for (const { name, listener } of listeners) {
  if (name === 'session/event') {
    listener(sub, { type: 'turn/start', data: { turn: 1 }, seq: 1 })
    listener(sub, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, seq: 2 })
    listener(sub, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 3 })
  }
}
await wait(30)
assert.equal(generatedCalls.length, before, 'disabled / error / subagent turns do not generate')

// ---- 流程 5：LLM 失败 → 兜底池 ----
streamMode = 'fail'
emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 6 }, seq: 18 })
emit({ type: 'user/message', time: Date.now() - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第六轮' }] }, seq: 19 })
emit({ type: 'turn/end', time: Date.now(), data: { turn: 6, reason: { kind: 'completed' } }, seq: 20 })
await wait(120)
{
  const res = makeRes()
  await routes.get('/api/quip/v1/quips').handler({ url: '/api/quip/v1/quips?session=session-test-1' }, res)
  const t6 = JSON.parse(res.body).quips.find((entry) => entry.turn === 6)
  assert.equal(t6?.source, 'fallback', 'fallback quip after llm failure')
}
{
  // 兜底句写进日志时的形状：必须和「模型真的生成了」在字段上可区分
  const rec6 = fakeSession.calls.map((c) => c.data).find((d) => d?.turn === 6)
  assert.ok(rec6, 'turn 6 record was appended')
  assert.deepEqual(rec6.message.source, { kind: 'dsh-quip' }, 'fallback line carries the plugin producer kind — no model attribution')
  assert.equal(rec6.plugin.source, 'fallback', 'plugin.source marks the text as fallback')
  assert.equal(rec6.plugin.outcome, 'error', 'plugin.outcome keeps why the model call fell back')
  assert.equal(rec6.usage, null, 'fail stream yields no usage chunk → usage is null, not fabricated')
  assert.equal(rec6.request.provider, 'deepseek', 'request still records the route that was attempted')
  assert.equal(rec6.plugin.finish, 'error', 'finish kind is recorded even when the stream failed')
  assert.deepEqual(rec6.plugin.failure, { code: 'PROVIDER_ERROR', message: 'provider down' }, 'failure summary mirrors the finish failure')
  // 本轮没有 assistant/message：锚点 seq/id 为 null，但 turn/end 的 seq（直接前驱）仍有
  assert.deepEqual(rec6.after, { seq: null, messageId: null, turnEndSeq: 20 }, 'no assistant reply this turn → anchor seq null, turnEndSeq still set')
}

// ---- 流程 6：超时必须被记录为 timeout，而不是混成 fallback ----
streamMode = 'hang'
emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 7 }, seq: 21 })
emit({ type: 'user/message', time: Date.now() - 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第七轮' }] }, seq: 22 })
emit({ type: 'turn/end', time: Date.now(), data: { turn: 7, reason: { kind: 'completed' } }, seq: 23 })
await wait(500) // > QUIP_TIMEOUT_MS(150) + 余量
{
  const res = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=5' }, res)
  const t7 = JSON.parse(res.body).generations.find((entry) => entry.turn === 7)
  assert.ok(t7, 'turn 7 traced')
  assert.equal(t7.outcome, 'timeout', 'model-call outcome records the timeout')
  assert.equal(t7.source, 'fallback', 'fallback still supplies a line after timeout')
  assert.match(t7.error, /exceeded 150 ms/)
  // 中途被中止的部分输出不再单独保留：text 就是用户最终看到的那句（兜底句），原因看 error
  assert.notEqual(t7.text, '半句', 'partial output is not what the user saw')
  assert.ok(t7.text !== '', 'fallback text is the final text')
  // 插件自己的超时信号先打断：finish 没拿到，失败事实也不存在
  assert.equal(t7.finishKind, null, 'timeout aborts before any finish chunk arrives')
  assert.equal(t7.failure, null, 'timeout carries no failure fact')
  // 超时的完整记录：timedOut / rawText / timing 细节只在全文里可读
  const full7 = await fullTraceOf(7)
  assert.ok(full7, 'turn 7 full trace retrievable via session + ts')
  assert.equal(full7.timedOut, true, 'the plugin timeout signal fired')
  assert.equal(full7.timeoutMs, 150, 'timeoutMs records the effective threshold')
  assert.equal(full7.rawText, '半句', 'rawText keeps the received-but-never-shown partial text')
  assert.equal(typeof full7.timing.firstTextMs, 'number', 'the partial text arrived before the abort')
  assert.ok(full7.timing.streamMs >= 150, 'streamMs covers at least the timeout window')
}
// 超时后仍按 fallback 配置给出一句，不丢轮
{
  const res = makeRes()
  await routes.get('/api/quip/v1/quips').handler({ url: '/api/quip/v1/quips?session=session-test-1' }, res)
  const t7 = JSON.parse(res.body).quips.find((entry) => entry.turn === 7)
  assert.equal(t7?.source, 'fallback')
}

// ---- 流程 6b：额度耗尽这类失败必须可见，不能被记成 ok ----
{
  streamMode = 'empty'
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 11 }, seq: 40 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第十一轮' }] }, seq: 41 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 11, reason: { kind: 'completed' } }, seq: 42 })
  await wait(150)
  {
    const res = makeRes()
    await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=5' }, res)
    const t11 = JSON.parse(res.body).generations.find((entry) => entry.turn === 11)
    assert.ok(t11, 'turn 11 traced')
    assert.equal(t11.outcome, 'empty', 'no-text stream is recorded as empty, not ok')
    assert.match(t11.error, /returned no text/)
    assert.equal(t11.finishKind, 'stop', 'the empty stream did end with a stop finish')
    assert.equal(t11.failure, null, 'a stop finish carries no failure')
    // 兜底仍然给出一句，用户不至于什么都没有
    assert.equal(t11.source, 'fallback')
    assert.ok(t11.text !== '', 'fallback still supplies a line')
  }
  {
    // 「调用了模型但零输出 → 兜底」与「没调模型 → 兜底」在 record 里靠 outcome 区分；
    // 前者带那次调用的真实 usage（全 0），后者 usage 为 null
    const rec11 = fakeSession.calls.map((c) => c.data).find((d) => d?.turn === 11)
    assert.ok(rec11, 'turn 11 record was appended')
    assert.equal(rec11.plugin.source, 'fallback')
    assert.equal(rec11.plugin.outcome, 'empty', 'outcome tells "model was called but returned nothing"')
    assert.deepEqual(rec11.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, 'real usage of the empty call is kept')
    assert.deepEqual(rec11.message.source, { kind: 'dsh-quip' }, 'still a fallback line, not a model line')
  }
  // finish chunk 自带 error 时同样记失败并保留原始原因
  streamMode = 'finishError'
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 12 }, seq: 43 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第十二轮' }] }, seq: 44 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 12, reason: { kind: 'completed' } }, seq: 45 })
  await wait(150)
  {
    const res = makeRes()
    await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=5' }, res)
    const t12 = JSON.parse(res.body).generations.find((entry) => entry.turn === 12)
    assert.equal(t12.outcome, 'error', 'a finish-chunk error is a failure')
    assert.match(t12.error, /insufficient quota/, 'the model error survives into the trace')
    assert.equal(t12.finishKind, 'error', 'finish kind records the failure ending')
    assert.deepEqual(t12.failure, { message: 'insufficient quota', code: 'ACCOUNT_QUOTA_EXCEEDED', status: 429 }, 'failure is kept verbatim')
  }
  {
    // 失败事实也精简进会话日志 record，让日志读者不用回查生成记录就能归因
    const rec12 = fakeSession.calls.map((c) => c.data).find((d) => d?.turn === 12)
    assert.ok(rec12, 'turn 12 record was appended')
    assert.equal(rec12.plugin.finish, 'error', 'record carries the finish kind')
    assert.deepEqual(rec12.plugin.failure, { code: 'ACCOUNT_QUOTA_EXCEEDED', message: 'insufficient quota', status: 429 }, 'record failure is the trimmed summary')
  }
  streamMode = 'ok'
}

// ---- 流程 7：思考等级解析 ----
{
  streamMode = 'ok'
  config.provider = 'deepseek'
  config.model = 'deepseek-reasoner'
  const before7 = generatedCalls.length
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 8 }, seq: 24 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第八轮' }] }, seq: 25 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 8, reason: { kind: 'completed' } }, seq: 26 })
  await wait(120)
  // auto → efforts[0]（最低），而不是 provider 侧可能很高的 defaultEffort(max)
  assert.equal(generatedCalls[before7].reasoningEffort, 'low', 'auto picks the lowest declared effort')
  assert.equal(generatedCalls[before7].model, 'deepseek-reasoner')
  const rec8 = fakeSession.calls.at(-1).data
  assert.equal(rec8.turn, 8)
  // 新结构：路由在 request，归属在 message.source
  assert.equal(rec8.request.reasoningEffort, 'low')
  assert.equal(rec8.message.source.provider, 'deepseek')
  assert.equal(rec8.message.source.model, 'deepseek-reasoner')
  // 生成记录带模型元数据与等级解析的两端：配置值（解析前）与实际生效值（解析后）
  {
    const res = makeRes()
    await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=50' }, res)
    const t8 = JSON.parse(res.body).generations.find((entry) => entry.turn === 8)
    assert.ok(t8, 'turn 8 traced')
    assert.equal(t8.configuredReasoningEffort, 'auto', 'the configured value is recorded before resolution')
    assert.equal(t8.reasoningEffort, 'low', 'auto resolves to the lowest declared effort')
    assert.deepEqual(t8.effortsOffered, ['low', 'high', 'max'], 'the declared efforts are recorded low to high')
    assert.equal(t8.providerDefaultEffort, 'max', 'the provider default effort is recorded')
    assert.equal(t8.modelContextWindow, 128000, 'contextWindow from resolveModelInfo lands in the trace')
    assert.equal(t8.modelDefaultMaxTokens, 8192, 'defaultMaxTokens from resolveModelInfo lands in the trace')
  }
  config.reasoningEffort = 'high'
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 9 }, seq: 27 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第九轮' }] }, seq: 28 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 9, reason: { kind: 'completed' } }, seq: 29 })
  await wait(120)
  assert.equal(generatedCalls[before7 + 1].reasoningEffort, 'high', 'explicit effort is passed through')
  {
    const res = makeRes()
    await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=50' }, res)
    const t9 = JSON.parse(res.body).generations.find((entry) => entry.turn === 9)
    assert.ok(t9, 'turn 9 traced')
    assert.equal(t9.configuredReasoningEffort, 'high', 'an explicit config effort is recorded as configured')
    assert.equal(t9.reasoningEffort, 'high', 'an explicit config effort is used as-is')
  }
  config.reasoningEffort = 'auto'
  config.provider = 'auto'
  config.model = 'auto'
  // 关闭 includeReasoning：素材不再带思考过程段
  config.includeReasoning = false
  const before10 = generatedCalls.length
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 10 }, seq: 30 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第十轮' }] }, seq: 31 })
  emit({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '内心戏' }, { type: 'text', text: '正文' }] } }, seq: 32 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 10, reason: { kind: 'completed' } }, seq: 33 })
  await wait(120)
  const material10 = generatedCalls[before10].messages[0].content[0].text
  assert.ok(!material10.includes('内心戏') && !material10.includes('思考过程'), 'reasoning omitted when disabled')
  assert.ok(material10.includes('正文'), 'visible text still present')
  config.includeReasoning = true
}

// ---- 流程 7b：quip 占最后一步之后的槽位，主对话的重试不影响它 ----
{
  streamMode = 'ok'
  const beforeR = fakeSession.calls.length
  // 主对话最后一步 step 1 重试了两次：那条 assistant/message 按 token-usage 的规则是 (20, 1, 2)
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 20 }, seq: 70 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '重试轮' }] }, seq: 71 })
  emit({ type: 'step/end', data: { turn: 20, step: 1 }, seq: 72 })
  emit({ type: 'llm/retry-started', data: { turn: 20, step: 1, retry: 1 }, seq: 73 })
  emit({ type: 'llm/retry-started', data: { turn: 20, step: 1, retry: 2 }, seq: 74 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 20, reason: { kind: 'completed' } }, seq: 75 })
  await wait(150)
  const recR = fakeSession.calls[beforeR].data
  assert.equal(recR.turn, 20)
  assert.equal(recR.step, 2, 'quip takes the slot after the last step: 1 + 1')
  assert.equal('attempt' in recR, false, 'no attempt field even when the main loop retried: those retries belong to step 1')
  // 主对话那条重试后成功的消息按 token-usage 规则是 (20, 1, 2)；quip 是 (20, 2, 0)——不同槽
  assert.notDeepEqual([recR.turn, recR.step, 0], [20, 1, 2], 'quip slot differs from the retried main-loop message')
}

// ---- 流程 8：跟随会话模型 ----
{
  streamMode = 'ok'
  config.followSessionModel = true
  // 会话记录一次用户切换（zai-coding-cn/glm-5.4 + max），之后生成必须用它
  emit({ type: 'model/selection', data: { provider: 'zai-coding-cn', model: 'glm-5.4', reasoningEffort: 'max' }, seq: 50 })
  const before8 = generatedCalls.length
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 13 }, seq: 51 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第十三轮' }] }, seq: 52 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 13, reason: { kind: 'completed' } }, seq: 53 })
  await wait(150)
  assert.equal(generatedCalls[before8].provider, 'zai-coding-cn', 'route follows the session selection')
  assert.equal(generatedCalls[before8].model, 'glm-5.4')
  assert.equal(generatedCalls[before8].reasoningEffort, 'max', 'session effort is used as-is')
  assert.equal(fakeSession.calls.at(-1).data.plugin.routeSource, 'session')

  // request/header 是实际请求路由，能补上会话没显式选的等级
  emit({ type: 'request/header', data: { header: { config: { provider: 'workbuddy', model: 'hy4flash-free', reasoningEffort: 'low' } } }, seq: 54 })
  const before8b = generatedCalls.length
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 14 }, seq: 55 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第十四轮' }] }, seq: 56 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 14, reason: { kind: 'completed' } }, seq: 57 })
  await wait(150)
  assert.equal(generatedCalls[before8b].provider, 'workbuddy', 'request header updates the tracked route')
  assert.equal(generatedCalls[before8b].model, 'hy4flash-free')
  assert.equal(generatedCalls[before8b].reasoningEffort, 'low')

  // 关闭跟随：回落到配置的 provider/model
  config.followSessionModel = false
  config.provider = 'deepseek'
  config.model = 'deepseek-reasoner'
  const before8c = generatedCalls.length
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 15 }, seq: 58 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第十五轮' }] }, seq: 59 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 15, reason: { kind: 'completed' } }, seq: 60 })
  await wait(150)
  assert.equal(generatedCalls[before8c].provider, 'deepseek', 'config route when not following')
  assert.equal(fakeSession.calls.at(-1).data.plugin.routeSource, 'config')
  config.followSessionModel = false
  config.provider = 'auto'
  config.model = 'auto'
}


// ---- 流程 8d：模型原文不再加工——带包裹引号的输出原样成为最终文本 ----
{
  streamMode = 'quoted'
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 21 }, seq: 61 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二十一轮' }] }, seq: 62 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 21, reason: { kind: 'completed' } }, seq: 63 })
  await wait(120)
  const res = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=5' }, res)
  const t21 = JSON.parse(res.body).generations.find((entry) => entry.turn === 21)
  assert.equal(t21.source, 'model')
  // 只去首尾空白：包裹整句的一对引号保留，不再剥掉；写进会话日志的也是同一句
  assert.equal(t21.text, '"把引号也当成我的一部分"', 'quoted model output is shown verbatim')
  assert.equal(fakeSession.calls.at(-1).data.message.content[0].text, '"把引号也当成我的一部分"', 'record text equals the shown text')
  streamMode = 'ok'
}


// ---- 流程 9：轮次中途插件重载（内存素材丢失）→ turn/end 时从会话日志补折，这轮不丢 ----
{
  // 模拟重载后的 ctx：turn/start 与中间事件都没被看到，只收到 turn/end；
  // readSession 返回的日志里本轮 turn/end 尚未持久化（批处理窗口内）——after.seq 来自日志、after.turnEndSeq 来自实时事件
  const sess = { id: 'session-rebuild', header: { origin: null, delegationDepth: 0 } }
  const before = generatedCalls.length
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 5, reason: { kind: 'completed' } }, seq: 30 }, sess)
  await wait(150)
  assert.equal(generatedCalls.length, before + 1, 'turn/end without in-memory material rebuilds it from the session log and still generates')
  const call = generatedCalls[before]
  assert.ok(call.messages[0].content[0].text.includes('补折轮次的用户发言'), 'rebuilt material carries the user text from the log')
  assert.ok(call.messages[0].content[0].text.includes('补折轮次的回复'), 'rebuilt material carries the assistant text from the log')
  const rec = fakeSession.calls.at(-1).data
  assert.equal(rec.turn, 5)
  assert.equal(rec.step, 4, 'virtual step = last step/end in the log + 1')
  assert.equal(rec.after.seq, 28, 'after.seq is the last assistant/message read from the log')
  assert.equal(rec.after.messageId, 'asst-rebuild')
  assert.equal(rec.after.turnEndSeq, 30, 'turnEndSeq comes from the live turn/end event')
  // 补折路径的 timing.rebuildMs 是非负数字（与实时折叠的 null 形成对照）
  const t5 = await fullTraceOf(5, 'session-rebuild')
  assert.ok(t5, 'turn 5 (rebuilt) traced')
  assert.ok(typeof t5.timing.rebuildMs === 'number' && t5.timing.rebuildMs >= 0, 'rebuildMs is a non-negative number on the rebuilt path')
  // 找不到本轮 turn/start（日志里没有这一轮）→ 安静放弃，不抛错、不生成
  const before2 = generatedCalls.length
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 77, reason: { kind: 'completed' } }, seq: 40 }, sess)
  await wait(80)
  assert.equal(generatedCalls.length, before2, 'a turn/end whose turn is absent from the log is dropped quietly')
}

// ---- 流程 10：素材逐字原样、思考取首尾两条、工具计次、脱敏开关 ----
{
  streamMode = 'ok'
  // 夹具全部是普通中文句子，故意不含 sk- / 长 hex / key=value 等会被脱敏的形态（脱敏另有 65/66 对照场景）。
  // R4 的「继续想。」重复 210 次 → 思考 870 字（真正超过八百字），轮 60 的素材总长才会明显大于
  // 生成记录曾经的 2000 字截断上限——这是「全文落 trace」断言能成立的前提。
  const USER_LONG = '请帮我把登录页的滚动条修一下，顺便看看提交按钮的样式。'.repeat(22) + '用户发言结尾标记'
  const S1 = '第一步的正文，先看 CSS。'
  const S2 = '第二步的正文，改了容器高度。'
  const S3 = '第三步的正文，跑了一遍回归。'
  const S4 = '第四步的正文，这里故意写一段超过三百字的说明：' + '补充说明。'.repeat(60) + '第四步结尾标记'
  const R1 = '第一步的思考：滚动条颜色可能被覆盖了。'
  const R2 = '第二步的思考：也可能是容器高度。'
  const R3 = '第三步的思考：回归应该没问题。'
  const R4 = '第四步的思考：这里写一段超过八百字的思考，' + '继续想。'.repeat(210) + '第四步思考结尾标记'
  const REASONING_SECTION = '【本轮助手思考过程（模型内心的犹豫、绕路与自我纠正；自评时可以引用）】'
  const TOOLS_LINE = '【本轮工具使用】共 5 次：read×2、edit×1、bash×2'
  const REPLY_4STEPS = '【本轮助手回复】\n第 1 步：' + S1 + '\n第 2 步：' + S2 + '\n第 3 步：' + S3 + '\n第 4 步：' + S4
  let seq = 200
  // 轮 60 与轮 61 用同一套夹具，只差 includeReasoning 开关
  const runFourStepTurn = async (turn) => {
    emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn }, seq: seq++ })
    emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: USER_LONG }] }, seq: seq++ })
    const steps = [[R1, S1], [R2, S2], [R3, S3], [R4, S4]]
    for (let i = 0; i < steps.length; i++) {
      emit({ type: 'assistant/message', data: { turn, step: i + 1, message: { id: `asst-${turn}-${i + 1}`, content: [
        { type: 'reasoning', text: steps[i][0] },
        { type: 'text', text: steps[i][1] },
      ] } }, seq: seq++ })
    }
    for (const name of ['read', 'edit', 'read', 'bash', 'bash']) {
      emit({ type: 'tool/call', data: { name }, seq: seq++ })
    }
    emit({ type: 'step/end', data: { turn, step: 4 }, seq: seq++ })
    emit({ type: 'turn/end', time: Date.now(), data: { turn, reason: { kind: 'completed' } }, seq: seq++ })
    await wait(150)
  }

  // 轮 60：四步轮次，includeReasoning 开、脱敏开——全文逐字、思考首尾两条、工具按名计次
  const before60 = generatedCalls.length
  await runFourStepTurn(60)
  assert.equal(generatedCalls.length, before60 + 1, '60: generated')
  const material60 = generatedCalls[before60].messages[0].content[0].text
  assert.ok(material60.includes('【本轮用户发言】\n' + USER_LONG), '60: user text verbatim, no truncation')
  assert.ok(!material60.includes('摘要') && !material60.includes('摘录'), '60: section titles no longer say 摘要/摘录')
  // 整段连续出现 = 无截断、无乱序、无插入
  assert.ok(material60.includes(REPLY_4STEPS), '60: all four reply steps verbatim and in order')
  // 思考只取首尾两条：第一条与最后一条全文；中间步骤的思考不进素材
  assert.ok(material60.includes(REASONING_SECTION + '\n第 1 步：' + R1 + '\n第 4 步：' + R4), '60: first and last reasoning only, full text')
  assert.ok(!material60.includes(R2) && !material60.includes(R3), '60: middle-step reasoning stays out')
  assert.ok(material60.includes(TOOLS_LINE), '60: tool counts by name in first-seen order, no 8-name cap')
  assert.ok(material60.indexOf('【本轮用户发言】') < material60.indexOf('【本轮助手回复】')
    && material60.indexOf('【本轮助手回复】') < material60.indexOf('【本轮工具使用】')
    && material60.indexOf('【本轮工具使用】') < material60.indexOf('【本轮耗时】')
    && material60.indexOf('【本轮耗时】') < material60.indexOf('【本轮助手思考过程'), '60: order user → reply → tools → duration → reasoning')
  assert.ok(material60.length > 2000, '60: the material is well over the old 2000-char trace cap')
  const t60 = await fullTraceOf(60)
  assert.ok(t60, '60: traced')
  assert.equal(t60.material, material60, '60: trace stores the full material, not a 2000-char slice')

  // 轮 61：同样的四步，includeReasoning 关——思考段整个不出现，其余各段不变
  config.includeReasoning = false
  const before61 = generatedCalls.length
  await runFourStepTurn(61)
  assert.equal(generatedCalls.length, before61 + 1, '61: generated')
  const material61 = generatedCalls[before61].messages[0].content[0].text
  assert.ok(!material61.includes('思考过程') && !material61.includes(R1) && !material61.includes(R4), '61: reasoning section omitted entirely when disabled')
  assert.ok(material61.includes('【本轮用户发言】\n' + USER_LONG), '61: user text verbatim')
  assert.ok(material61.includes(REPLY_4STEPS), '61: reply steps verbatim')
  assert.ok(material61.includes(TOOLS_LINE), '61: tool counts unchanged')
  config.includeReasoning = true

  // 轮 62：单步轮次、没有 data.step——同一条思考只出现一次，正文不带「第 N 步：」
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 62 }, seq: seq++ })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '单步轮次的用户发言' }] }, seq: seq++ })
  emit({ type: 'assistant/message', data: { message: { id: 'asst-62-1', content: [
    { type: 'reasoning', text: '只有一步的思考' },
    { type: 'text', text: '只有一步的正文' },
  ] } }, seq: seq++ })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 62, reason: { kind: 'completed' } }, seq: seq++ })
  await wait(150)
  const material62 = generatedCalls.at(-1).messages[0].content[0].text
  assert.equal(material62.split('只有一步的思考').length - 1, 1, '62: the single reasoning appears exactly once (first === last)')
  assert.ok(material62.includes('【本轮助手回复】\n只有一步的正文'), '62: no step label without data.step')

  // 轮 63：整轮没有思考——渲染占位句而不是空段
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 63 }, seq: seq++ })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '无思考轮次的用户发言' }] }, seq: seq++ })
  emit({ type: 'assistant/message', data: { message: { id: 'asst-63-1', content: [{ type: 'text', text: '没有思考的正文' }] } }, seq: seq++ })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 63, reason: { kind: 'completed' } }, seq: seq++ })
  await wait(150)
  const material63 = generatedCalls.at(-1).messages[0].content[0].text
  assert.ok(material63.includes('（本轮无思考过程）'), '63: no-reasoning placeholder shown')

  // 轮 64：120 步大轮次——回复逐字无截断，同名工具计次不封顶，trace 全文等长
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 64 }, seq: seq++ })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '百步轮次的用户发言' }] }, seq: seq++ })
  for (let i = 1; i <= 120; i++) {
    emit({ type: 'assistant/message', data: { turn: 64, step: i, message: { id: `asst-64-${i}`, content: [{ type: 'text', text: `第${i}步正文内容，这一步做了事情。` }] } }, seq: seq++ })
  }
  for (let i = 0; i < 120; i++) {
    emit({ type: 'tool/call', data: { name: 'read' }, seq: seq++ })
  }
  emit({ type: 'step/end', data: { turn: 64, step: 120 }, seq: seq++ })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 64, reason: { kind: 'completed' } }, seq: seq++ })
  await wait(150)
  const material64 = generatedCalls.at(-1).messages[0].content[0].text
  const expectedReply = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 步：第${i + 1}步正文内容，这一步做了事情。`).join('\n')
  assert.ok(material64.includes('【本轮助手回复】\n' + expectedReply), '64: all 120 steps verbatim and in order')
  assert.ok(material64.includes('共 120 次：read×120'), '64: 120 same-name calls counted, no cap')
  assert.ok(material64.length > 120 * 20, '64: a 120-step material is far larger than the old caps allowed')
  const t64 = await fullTraceOf(64)
  assert.ok(t64, '64: traced')
  assert.equal(t64.material.length, material64.length, '64: the trace stores the material in full')

  const SECRET_TEXT = '我的密钥是 sk-abcdefghijklmnopqrstuvwx 请保管好'
  // 轮 65：脱敏关——原文（含密钥形态）逐字进素材，trace 快照 redact=false
  config.redact = false
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 65 }, seq: seq++ })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: SECRET_TEXT }] }, seq: seq++ })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 65, reason: { kind: 'completed' } }, seq: seq++ })
  await wait(150)
  const material65 = generatedCalls.at(-1).messages[0].content[0].text
  assert.ok(material65.includes('sk-abcdefghijklmnopqrstuvwx'), '65: redact off → the secret shape survives verbatim')
  const t65 = await fullTraceOf(65)
  assert.ok(t65, '65: traced')
  assert.equal(t65.redacted, false, '65: trace snapshots redact=off')
  // 轮 66：脱敏开（对照）——密钥形态被替换为 [redacted]
  config.redact = true
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 66 }, seq: seq++ })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: SECRET_TEXT }] }, seq: seq++ })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 66, reason: { kind: 'completed' } }, seq: seq++ })
  await wait(150)
  const material66 = generatedCalls.at(-1).messages[0].content[0].text
  assert.ok(!material66.includes('sk-abcdefghijklmnopqrstuvwx'), '66: redact on → the secret shape is replaced')
  assert.ok(material66.includes('[redacted]'), '66: the redaction marker appears')
  const t66 = await fullTraceOf(66)
  assert.ok(t66, '66: traced')
  assert.equal(t66.redacted, true, '66: trace snapshots redact=on')

  // 补折路径：session-rebuild2 的内存素材缺失，只发 turn/end 触发从日志补折
  const sess2 = { id: 'session-rebuild2', header: { origin: null, delegationDepth: 0 } }
  const beforeR2 = generatedCalls.length
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 80, reason: { kind: 'completed' } }, seq: seq++ }, sess2)
  await wait(150)
  assert.equal(generatedCalls.length, beforeR2 + 1, 'rebuild2: turn/end without in-memory material rebuilds from the log')
  const materialR2 = generatedCalls.at(-1).messages[0].content[0].text
  assert.ok(materialR2.includes('【本轮助手回复】\n第 1 步：补折2第一步的正文\n第 2 步：补折2第二步的正文'), 'rebuild2: both reply steps verbatim with step labels')
  assert.ok(materialR2.includes(REASONING_SECTION), 'rebuild2: reasoning section present')
  assert.ok(materialR2.includes('第 1 步：补折2第一步的思考\n第 2 步：补折2第二步的思考'), 'rebuild2: first and last reasoning both appear')
  assert.ok(materialR2.includes('【本轮工具使用】共 1 次：grep×1'), 'rebuild2: tool counted by name')
  const tR2 = await fullTraceOf(80, 'session-rebuild2')
  assert.ok(tR2, 'rebuild2: traced')
  assert.ok(typeof tR2.timing.rebuildMs === 'number', 'rebuild2: rebuildMs is a number on the rebuilt path')
}

// ---- 流程 6c：结束形态按宿主协议判定 ----
{
  let seq = 64
  const runTurn = async (turn) => {
    emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn }, seq: seq++ })
    emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮` }] }, seq: seq++ })
    emit({ type: 'turn/end', time: Date.now(), data: { turn, reason: { kind: 'completed' } }, seq: seq++ })
    await wait(150)
  }
  const scenarios = [
    {
      // 半句 + finish error：失败先于文本，半句绝不展示
      mode: 'errorPartial', turn: 30,
      check: (t, rec) => {
        assert.equal(t.outcome, 'error', '30: finish error makes the call a failure')
        assert.equal(t.source, 'fallback', '30: partial text is not shown')
        assert.ok(t.text !== '半句还没说完' && t.text !== '', '30: the shown line is a fallback line')
        assert.equal(t.finishKind, 'error', '30: finish kind is error')
        assert.equal(t.failure.code, 'ACCOUNT_QUOTA_EXCEEDED', '30: failure carries the provider code')
        assert.equal(t.failure.status, 429, '30: failure carries the http status verbatim')
        assert.equal(rec.plugin.source, 'fallback', '30: record source is fallback')
        assert.equal(rec.plugin.outcome, 'error', '30: record outcome is error')
        assert.equal(rec.plugin.finish, 'error', '30: record finish is error')
        assert.deepEqual(rec.plugin.failure, { code: 'ACCOUNT_QUOTA_EXCEEDED', message: 'insufficient quota', status: 429 }, '30: record failure is the trimmed summary')
        assert.equal(rec.message.content[0].text, t.text, '30: record text equals the shown text')
        assert.equal(rec.usage, null, '30: no usage chunk arrived → usage is null')
        assert.ok('finish' in rec.plugin && 'failure' in rec.plugin, '30: record plugin carries finish and failure keys')
      },
    },
    {
      // 半句 + finish aborted：宿主侧中止，部分输出同样不展示
      mode: 'abortedPartial', turn: 31,
      check: (t, rec) => {
        assert.equal(t.outcome, 'aborted', '31: finish aborted is its own outcome')
        assert.equal(t.source, 'fallback', '31: partial text is not shown')
        assert.ok(t.text !== '半句还没说完' && t.text !== '', '31: the shown line is a fallback line')
        assert.equal(t.finishKind, 'aborted', '31: finish kind is aborted')
        assert.match(t.error, /aborted/, '31: the error names the abort')
        assert.match(t.error, /cancelled/, '31: the failure message survives into the error')
        assert.equal(rec.plugin.finish, 'aborted', '31: record finish is aborted')
        assert.deepEqual(rec.plugin.failure, { code: 'ABORTED', message: 'cancelled' }, '31: record failure has no status key')
      },
    },
    {
      // 半句 + finish max-tokens：宿主已经正常收尾，收到的文本照常展示
      mode: 'maxTokensPartial', turn: 32,
      check: (t, rec) => {
        assert.equal(t.outcome, 'ok', '32: max-tokens with text is still ok')
        assert.equal(t.source, 'model', '32: the text came from the model')
        assert.equal(t.text, '撞上限的半句', '32: the partial text is shown verbatim')
        assert.equal(t.finishKind, 'max-tokens', '32: finish kind records the limit ending')
        assert.equal(t.failure, null, '32: max-tokens carries no failure')
        assert.equal(rec.message.source.kind, 'model', '32: record is a model line')
        assert.equal(rec.plugin.finish, 'max-tokens', '32: record finish is max-tokens')
        assert.equal('failure' in rec.plugin, false, '32: no failure key on a clean ending')
      },
    },
    {
      // 无文本 + usage + finish error：与「正常结束但零输出」可区分——这是失败，不是 empty
      mode: 'errorEmpty', turn: 33,
      check: (t, rec) => {
        assert.equal(t.outcome, 'error', '33: finish error is an error, not empty')
        assert.notEqual(t.outcome, 'empty', '33: a failed call is not misrecorded as empty')
        assert.equal(t.source, 'fallback', '33: fallback supplies the line')
        assert.equal(t.finishKind, 'error', '33: finish kind is error')
        assert.equal(t.failure.code, 'INVALID_CREDENTIAL', '33: failure carries the auth code')
        assert.deepEqual(t.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, '33: the received usage is still recorded')
        assert.deepEqual(rec.plugin.failure, { code: 'INVALID_CREDENTIAL', message: 'bad key', status: 401 }, '33: record failure is the trimmed summary')
      },
    },
    {
      // 无文本 + usage，流直接结束（无 finish）：这才是 empty；与 33 的 error 形成对照
      mode: 'noFinishEmpty', turn: 34,
      check: (t, rec) => {
        assert.equal(t.outcome, 'empty', '34: a stream without finish and without text is empty')
        assert.equal(t.finishKind, null, '34: no finish chunk → finishKind null')
        assert.equal(t.failure, null, '34: no finish chunk → no failure')
        assert.match(t.error, /finish=none/, '34: the error names the missing finish')
      },
    },
    {
      // 有文本，无 finish 流结束：宿主组装器按正常收尾对待，展示
      mode: 'noFinishText', turn: 35,
      check: (t) => {
        assert.equal(t.outcome, 'ok', '35: text without a finish is still ok')
        assert.equal(t.text, '没有终态的一句', '35: the text is shown verbatim')
        assert.equal(t.finishKind, null, '35: no finish chunk → finishKind null')
      },
    },
    {
      // 哨兵 + finish error：失败先于 skip，哨兵救不了这轮
      mode: 'skipOnError', turn: 36,
      check: (t) => {
        assert.equal(t.outcome, 'error', '36: failure wins over the skip sentinel')
        assert.equal(t.source, 'fallback', '36: fallback supplies the line')
      },
    },
    {
      // 哨兵 + finish stop：模型自己决定不说，不写会话日志 record
      mode: 'skipOnStop', turn: 37,
      check: (t, rec) => {
        assert.equal(t.outcome, 'skip', '37: sentinel with a clean stop is a skip')
        assert.equal(t.source, 'skip', '37: nothing was shown')
        assert.equal(t.finishKind, 'stop', '37: finish kind is stop')
        assert.equal(rec, undefined, '37: skip writes no session-log record')
      },
    },
    {
      // 思考增量 + 正文 + usage + 带 replayState 的 stop
      mode: 'reasoning', turn: 38,
      check: async (t) => {
        assert.equal(t.outcome, 'ok', '38: reasoning + text + stop is ok')
        // usage 原样透传：provider 多报的字段（cachedTokens）也保留
        assert.deepEqual(t.usage, { inputTokens: 9, outputTokens: 7, reasoningTokens: 3, cachedTokens: 11 }, '38: usage is passed through verbatim, extra fields kept')
        assert.equal(t.finishKind, 'stop', '38: finish kind is stop')
        // replayState / reasoningText 是大字段，只在单条全文里
        const full = await fullTraceOf(38)
        assert.ok(full, '38: full trace retrievable')
        assert.equal(full.reasoningText, '先想想', '38: reasoning deltas concatenate into the trace')
        assert.deepEqual(full.replayState, { response: { id: 'resp_1' } }, '38: replay state is kept verbatim')
      },
    },
    {
      // 迭代中途抛带 failure 的异常（宿主 LlmError 形状）：失败事实取 failure 原样
      mode: 'throwsLlmError', turn: 39,
      check: (t) => {
        assert.equal(t.outcome, 'error', '39: a thrown stream is a failure')
        assert.deepEqual(t.failure, { message: 'stream closed', code: 'STREAM_CLOSED' }, '39: the LlmError failure is kept verbatim')
        assert.ok(t.text !== '半句', '39: partial text is not shown')
        assert.match(t.error, /stream closed/, '39: the thrown message survives into the error')
        assert.equal(t.finishKind, null, '39: no finish chunk arrived')
      },
    },
    {
      // 迭代中途抛普通异常：失败事实折成 { code: error.name, message }
      mode: 'throwsPlain', turn: 40,
      check: (t) => {
        assert.equal(t.outcome, 'error', '40: a plain throw is a failure')
        assert.deepEqual(t.failure, { code: 'Error', message: 'boom' }, '40: a plain error is folded into a failure fact')
      },
    },
  ]
  for (const { mode, turn, check } of scenarios) {
    streamMode = mode
    await runTurn(turn)
    const res = makeRes()
    await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=50' }, res)
    const t = JSON.parse(res.body).generations.find((entry) => entry.turn === turn)
    assert.ok(t, `${mode}: turn ${turn} traced`)
    const rec = fakeSession.calls.map((c) => c.data).find((d) => d?.turn === turn)
    await check(t, rec)
  }
  streamMode = 'ok'
}

// ---- 流程 6d：超时配置（QUIP_TIMEOUT_MS 优先）与没有兜底时的死字段 ----
{
  let seq = 100
  const runTurn = async (turn) => {
    emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn }, seq: seq++ })
    emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮` }] }, seq: seq++ })
    emit({ type: 'turn/end', time: Date.now(), data: { turn, reason: { kind: 'completed' } }, seq: seq++ })
    await wait(150)
  }
  // 轮 50：环境变量清掉后，配置 timeoutSeconds 生效（秒 → 毫秒）
  streamMode = 'ok'
  delete process.env.QUIP_TIMEOUT_MS
  config.timeoutSeconds = 45
  await runTurn(50)
  const t50 = await fullTraceOf(50)
  assert.ok(t50, '50: traced')
  assert.equal(t50.timeoutMs, 45000, 'timeoutSeconds applies when QUIP_TIMEOUT_MS is absent')
  assert.equal(t50.timedOut, false, 'a fast turn does not trip the 45 s timeout')
  // 轮 51：环境变量优先于配置
  process.env.QUIP_TIMEOUT_MS = '150'
  await runTurn(51)
  const t51 = await fullTraceOf(51)
  assert.ok(t51, '51: traced')
  assert.equal(t51.timeoutMs, 150, 'QUIP_TIMEOUT_MS overrides timeoutSeconds')
  assert.equal(t51.timedOut, false)
  // 轮 52：模型失败 + 兜底关闭 → 无文本可展示，也不写会话日志
  config.fallback = false
  streamMode = 'fail'
  await runTurn(52)
  const t52 = await fullTraceOf(52)
  assert.ok(t52, '52: traced')
  assert.equal(t52.outcome, 'error')
  assert.equal(t52.source, 'error', 'no text anywhere → source stays error')
  assert.equal(t52.text, '', 'fallback disabled → nothing is shown')
  assert.equal(t52.timing.persistMs, null, 'no session-log append was attempted → persistMs stays null')
  assert.equal(t52.recordSeq, null, 'no session-log append → no seq')
  assert.equal(fakeSession.calls.map((c) => c.data).find((d) => d?.turn === 52), undefined, 'no session-log record without a shown line')
  // 离开本块前恢复环境变量与配置快照
  delete config.timeoutSeconds
  config.fallback = true
  streamMode = 'ok'
  // /status 暴露两个新配置项（恢复后的默认值）
  {
    const res = makeRes()
    await routes.get('/api/quip/v1/status').handler({ url: '/api/quip/v1/status' }, res)
    const body = JSON.parse(res.body)
    assert.equal(body.config.timeoutSeconds, 120, 'timeoutSeconds defaults to 120')
    assert.equal(body.config.redact, true, 'redact defaults to on')
  }
}

// ---- 流程 6e：POST /config 写回（timeoutSeconds 校验与夹取） ----
{
  const editsBefore = configEdits.length
  const ok = await postConfig({ config: { timeoutSeconds: 9999, redact: false } })
  assert.equal(ok.status, 200, 'a numeric timeoutSeconds is accepted')
  assert.equal(configEdits.at(-1).timeoutSeconds, 600, 'out-of-range values are clamped to 600 before the editor')
  assert.equal(configEdits.at(-1).redact, false, 'redact passes through to the editor')
  const bad = await postConfig({ config: { timeoutSeconds: 'abc' } })
  assert.equal(bad.status, 400, 'a non-numeric timeoutSeconds is rejected')
  assert.match(bad.body, /timeoutSeconds must be a number/, 'the error names the field')
  assert.equal(configEdits.length, editsBefore + 1, 'the rejected patch never reaches the config editor')
}

// ---- 生成记录落盘：按 500 条分文件、只追加不重写、永久保留 ----
{
  const dir = join(process.env.QUIP_DATA_DIR, 'generations')
  const names = readdirSync(dir).sort()
  // 预置的满文件 + 迁移进来的旧文件 + 本次运行新建的文件；旧版单文件已不在数据目录根下
  assert.deepEqual(names.slice(0, 2), ['generations-20240601-120000.jsonl', PREFILL_NAME], 'legacy file migrated with its first-record stamp; prefill kept')
  assert.equal(names.length, 3, 'a full file makes the next record start a new file')
  assert.equal(existsSync(join(process.env.QUIP_DATA_DIR, 'generations.jsonl')), false, 'legacy single file was moved, not copied')
  const freshName = names[2]
  assert.match(freshName, /^generations-\d{8}-\d{6}\.jsonl$/, 'file name is the first record\'s local time')
  const lines = readFileSync(join(dir, freshName), 'utf8').split('\n').filter(Boolean)
  // 触发生成的轮次：1 2(brand-fail) 3(sse) 6(llm-fail) 7(timeout) 8 9 10 11(empty) 12(finish-error)
  // 13 14 15(跟随/固定路由) 20(step+1) 21(quoted) 5(rebuild) = 16 条；
  // 30–40(流程 6c 结束形态，error/aborted/skip/empty/ok/timeout 等每次尝试都记) = 11 条；
  // 50 51(超时配置) 52(无兜底失败) = 3 条；
  // 60 61 62 63 64 65 66(流程 10 素材逐字/思考首尾/百步/脱敏开关) + 80(session-rebuild2 补折) = 8 条，共 38 条
  assert.equal(lines.length, 38, 'one generation record per attempted turn, all in the fresh file')
  const traces = lines.map((line) => JSON.parse(line))
  // 文件按追加顺序，第一条是 turn 1
  const first = traces[0]
  assert.equal(first.turn, 1)
  // 定位坐标：recordSeq 是 appendPluginRecord 返回的日志 seq（fake 包返回调用次数 → 1）；
  // step / messageId / afterSeq / turnEndSeq 与写进会话日志的 record 一致，面板据此定位到那一行
  assert.equal(first.recordSeq, 1, 'recordSeq is the seq returned by appendPluginRecord')
  const rec1 = fakeSession.calls[0].data
  assert.equal(first.step, rec1.step)
  assert.equal(first.messageId, rec1.message.id)
  assert.equal(first.afterSeq, rec1.after.seq)
  assert.equal(first.turnEndSeq, rec1.after.turnEndSeq)
  for (const trace of traces) {
    assert.equal(trace.file, freshName, 'every record names the file it lives in')
    assert.equal('raw' in trace, false, 'raw is gone: one text field only')
    assert.equal('cleaned' in trace, false, 'cleaned is gone: one text field only')
    assert.deepEqual(
      ['afterSeq', 'file', 'messageId', 'recordSeq', 'step', 'text', 'turnEndSeq'].filter((key) => !(key in trace)),
      [], `every trace carries the locate coordinates: ${JSON.stringify(Object.keys(trace))}`)
    // 三个终态字段无条件存在：值可以为 null，但键不能缺
    assert.ok('finishKind' in trace, 'every trace carries finishKind')
    assert.ok('failure' in trace, 'every trace carries failure')
    assert.ok('replayState' in trace, 'every trace carries replayState')
    assert.equal('maxTokens' in trace, false, 'maxTokens is a dead field: dropped from new records too')
  }
  // 写入失败（turn 2 品牌检查失败）的记录：recordSeq 为 null，但 step / messageId 仍在
  const brandFail = traces.find((trace) => trace.turn === 2)
  assert.equal(brandFail.recordSeq, null, 'failed persist leaves recordSeq null')
  assert.equal(typeof brandFail.messageId, 'string', 'messageId is still recorded when persist fails')
  // 预置文件未被改动：永久保留、不重写
  const prefillLines = readFileSync(join(dir, PREFILL_NAME), 'utf8').split('\n').filter(Boolean)
  assert.equal(prefillLines.length, 500, 'the full pre-existing file is untouched')
  // 迁移文件内容与原旧文件一致（只 rename）
  const migrated = JSON.parse(readFileSync(join(dir, names[0]), 'utf8').trim())
  assert.equal(migrated.cleaned, '旧格式的最终文本', 'migration only renames; content untouched')
}

// ---- 删文件后重载：用户在文件管理器里删掉记录文件，面板查询立即反映 ----
{
  const before = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=500' }, before)
  const beforeList = JSON.parse(before.body).generations
  assert.equal(beforeList.length, 500, 'memory cap: at most GEN_MEMORY_LIMIT records')
  assert.ok(beforeList.some((entry) => entry.session === 'session-prefill'), 'pre-existing file is loaded into memory')
  rmSync(join(process.env.QUIP_DATA_DIR, 'generations', PREFILL_NAME))
  const after = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=500' }, after)
  const afterList = JSON.parse(after.body).generations
  assert.equal(afterList.some((entry) => entry.session === 'session-prefill'), false, 'deleted file drops out without a restart')
  assert.equal(afterList.length, 39, '38 fresh + 1 migrated legacy record')
  const legacy = afterList.find((entry) => entry.session === 'session-legacy')
  assert.equal(legacy.text, '旧格式的最终文本', 'legacy cleaned field is normalised into text on load')
  assert.equal('raw' in legacy, false, 'legacy raw is dropped on load')
  assert.equal('maxTokens' in legacy, false, 'legacy maxTokens is dropped on load (the disk line keeps it)')
  assert.equal(legacy.file, 'generations-20240601-120000.jsonl', 'legacy record names the migrated file')
  // limit 上限 500：请求 1000 也只给 500
  const capped = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=1000' }, capped)
  assert.equal(JSON.parse(capped.body).generations.length, 39)
}

// ---- status：暴露记录目录的真实路径（面板「打开记录文件夹」用） ----
{
  const res = makeRes()
  await routes.get('/api/quip/v1/status').handler({ url: '/api/quip/v1/status' }, res)
  assert.equal(JSON.parse(res.body).dataDir, realpathSync(join(process.env.QUIP_DATA_DIR, 'generations')), 'dataDir is the real path of the records dir')
}


console.log('host mock integration smoke: ALL OK')
process.exit(0)
