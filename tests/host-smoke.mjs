/**
 * host 半边的 mock 集成冒烟（不进发布包）。
 *
 * 与旧版的区别：会话日志写入器不再是桩。测试在临时目录里放一个**假的
 * dsh-session 包**，让 `candidateSessionModules → resolveSessionWriter` 真实
 * 走一遍解析与 import；假包的 `appendPluginRecord` 可切换为抛品牌检查错误，
 * 用来验证「写入失败必须可见」这条路径——这正是旧测试全绿而真实写入
 * 三次失败的原因。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, pluginRecordOf, isCurrentQuipRecord, textOfRecord, PURGED_RECORD_TYPE, candidateSessionModules, probeHostSessionUrl } from '../src/index.js'

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

const okStream = (text) => (async function* () {
  for (const piece of text.match(/./gu) ?? []) {
    yield { type: 'text-delta', index: 0, text: piece }
  }
  yield { type: 'usage', usage: { inputTokens: 321, outputTokens: 12, totalTokens: 333 } }
  yield { type: 'finish', reason: 'stop' }
})()

const ctx = {
  llm: {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
    // 精确模型元数据：声明从低到高的思考等级（与真实 adapter 的 efforts 排列一致）。
    // 注意宿主里必须用 resolveModelInfo——resolveModel 是基类占位，永远不带 reasoning。
    resolveModelInfo: async (provider, model) => ({
      provider, id: model, name: model,
      ...(model === 'deepseek-reasoner' ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } } : {}),
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
        return (async function* () {
          yield { type: 'finish', reason: 'error' }
          throw new Error('provider down')
        })()
      }
      if (streamMode === 'empty') {
        // 额度耗尽这类失败的真实形态：流正常结束、零文本、usage 全 0、不抛异常
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
          yield { type: 'finish', reason: 'stop' }
        })()
      }
      if (streamMode === 'finishError') {
        // 失败写在 finish chunk 上（adapter 规范化错误），不抛异常
        return (async function* () {
          yield { type: 'finish', reason: 'error', error: new Error('insufficient quota') }
        })()
      }
      if (streamMode === 'quoted') return okStream('"把引号也当成我的一部分"')
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
      return { readSession: async (id) => ({ events: id === 'session-rebuild' ? rebuildEvents : coldLogEvents }) }
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
  JSON.stringify({ ts: LEGACY_TS, session: 'session-legacy', turn: 90001, raw: 'ignored', cleaned: '旧格式的最终文本', source: 'model' }) + '\n')
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

// generations 端点
{
  const res = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=10' }, res)
  const body = JSON.parse(res.body)
  const record = body.generations[0]
  assert.equal(record.source, 'model')
  assert.equal(record.text, '（叉腰）这波我自己都觉得很可以')
  assert.equal('raw' in record, false, 'one text field only')
  assert.ok(record.material.includes('帮我修一下登录页'))
  assert.ok(record.systemPrompt.includes('俏皮'))
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
  config.reasoningEffort = 'high'
  emit({ type: 'turn/start', time: Date.now() - 1000, data: { turn: 9 }, seq: 27 })
  emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第九轮' }] }, seq: 28 })
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 9, reason: { kind: 'completed' } }, seq: 29 })
  await wait(120)
  assert.equal(generatedCalls[before7 + 1].reasoningEffort, 'high', 'explicit effort is passed through')
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
  // 找不到本轮 turn/start（日志里没有这一轮）→ 安静放弃，不抛错、不生成
  const before2 = generatedCalls.length
  emit({ type: 'turn/end', time: Date.now(), data: { turn: 77, reason: { kind: 'completed' } }, seq: 40 }, sess)
  await wait(80)
  assert.equal(generatedCalls.length, before2, 'a turn/end whose turn is absent from the log is dropped quietly')
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
  // 13 14 15(跟随/固定路由) 20(step+1) 21(quoted) 5(rebuild) = 16 条
  assert.equal(lines.length, 16, 'one generation record per attempted turn, all in the fresh file')
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
  assert.equal(afterList.length, 17, '16 fresh + 1 migrated legacy record')
  const legacy = afterList.find((entry) => entry.session === 'session-legacy')
  assert.equal(legacy.text, '旧格式的最终文本', 'legacy cleaned field is normalised into text on load')
  assert.equal('raw' in legacy, false, 'legacy raw is dropped on load')
  assert.equal(legacy.file, 'generations-20240601-120000.jsonl', 'legacy record names the migrated file')
  // limit 上限 500：请求 1000 也只给 500
  const capped = makeRes()
  await routes.get('/api/quip/v1/generations').handler({ url: '/api/quip/v1/generations?limit=1000' }, capped)
  assert.equal(JSON.parse(capped.body).generations.length, 17)
}

// ---- status：暴露记录目录的真实路径（面板「打开记录文件夹」用） ----
{
  const res = makeRes()
  await routes.get('/api/quip/v1/status').handler({ url: '/api/quip/v1/status' }, res)
  assert.equal(JSON.parse(res.body).dataDir, realpathSync(join(process.env.QUIP_DATA_DIR, 'generations')), 'dataDir is the real path of the records dir')
}


console.log('host mock integration smoke: ALL OK')
process.exit(0)
