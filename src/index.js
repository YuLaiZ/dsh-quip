/**
 * dsh-quip（俏皮话）Host 半边。
 *
 * 职责：
 * 1. 订阅 `session/event`，按轮折叠素材（用户发言摘要、助手输出摘要、
 *    工具使用统计、轮次时长）——素材进模型前统一脱敏，工具结果永不进素材。
 * 2. `turn/end`（reason.kind 为 completed；中断类可配置）后发起一次
 *    独立的已注册模型小调用（`ctx.llm.stream`）生成一句自评。
 * 3. 生成结果写三处：内存（供端点与 SSE 读）、会话日志 plugin record
 *    （持久层真相源：重启后冷读恢复、fork/导出携带、任何遍历会话事件的
 *    统计工具都能取到 token usage）、生成过程记录（按 500 条分文件的 jsonl，
 *    永久保留，供设置卡查看；用户可在设置卡打开目录自行删除）。
 * 4. 通过 `ctx.webServer.register` 开放同源端点：
 *    - GET  /api/quip/v1/health              匿名；运行态与持久化诊断
 *    - GET  /api/quip/v1/status              匿名；配置 + provider/model 目录
 *    - GET  /api/quip/v1/quips?session=<id>  当前会话的全部俏皮话（JSON）
 *    - GET  /api/quip/v1/watch?session=<id>  增量订阅（SSE）
 *    - GET  /api/quip/v1/generations         生成过程记录
 *    - POST /api/quip/v1/config              写回插件配置（configEditor）
 *
 * 持久化的硬约束（见 project-docs 方案文档「未解决的问题 ①」）：
 * `appendPluginRecord` 经 Session 的 `#appendRecord` 私有方法写入，V8 对私有
 * 方法的品牌检查绑定在**类定义**上。只有拿到宿主进程加载的那个 dsh-session
 * 模块实例，写入才会成功；npm 副本或另一 URL 的副本都抛
 * "Receiver must be an instance of class Session"。公开的 `session.append()`
 * 不可替代：它写出的事件缺 `ignorable` 标记，读回时会被白名单拒绝。
 * 本文件用「宿主 Session 方法源 URL 探测 + 候选 URL 比对」把这件事变成可诊断的。
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import {
  CUSTOM_STYLE_ID,
  SKIP_SENTINEL,
  STYLE_IDS,
  buildSystemPrompt,
  fallbackPoolOf,
} from './styles.js'
import {
  foldEvent,
  freshTurnMaterial,
  materialWorthQuip,
  renderMaterial,
} from './quip-lib.js'

// ---- 常量 ----

/** 需要的宿主服务：LLM 调用与 HTTP 路由。 */
export const inject = ['webServer', 'llm']

/** 端点统一前缀。 */
const API_PREFIX = '/api/quip/v1'
/** 插件标识（SSE/JSON 负载与日志前缀）。 */
const PLUGIN_TAG = 'dsh-quip'
/** 会话日志里的 record 类型。`plugin:` 前缀 + 全小写段语法，带 `ignorable` 标记。 */
const RECORD_TYPE = 'plugin:dsh-quip/quip'
/**
 * plugin record 的 `data` 格式版本。当前为 1。
 *
 * v1 是一次清零：此前的记录格式与全部历史数据一并作废、从会话日志清除，格式版本从 1 重新计起
 * （插件的包版本与此无关：未发布不改版本号，一直是 0.1.0）。
 * 冷读只认 `v === 1` 且结构完整的记录；清除历史时写入的 {@link PURGED_RECORD_TYPE} 占位行 type 不同，自然落选。
 *
 * 结构（与 DSH 原生 `assistant/message.data` 同构）：
 *   { v, turn, step, message, usage, request, after, plugin }
 * - step = 本轮最后一个 step/end + 1：quip 在 turn/end 后才生成，挂在最后一步之后，占一个
 *   DSH 循环永远不会走到的虚拟步，(turn, step) 不与本轮任何 assistant/message 同槽
 * - message.source.kind 说的是「谁产生了这句话」：模型生成 → model（带 provider/model）；
 *   兜底句 → 插件自有 producer kind（见 FALLBACK_SOURCE_KIND），不挂任何模型归属
 * - after = { seq, messageId, turnEndSeq }：钉回所评论的那条 assistant/message 与 turn/end
 * - plugin = { name, purpose, style, source, outcome, routeSource, durationMs }：source 标文本
 *   来源（model / fallback / no-provider），outcome 标模型调用的结局（ok / empty / timeout /
 *   aborted / error / no-provider），「调了但失败→兜底」与「没调→兜底」在日志里可分辨
 */
const RECORD_FORMAT_VERSION = 1
/**
 * 清除历史 record 时写入的占位 type：内容清空，外层 seq / time 原样保留。
 * 仍是本插件命名空间下的合法 plugin record type，带 `ignorable`，任何读者都安全跳过。
 */
export const PURGED_RECORD_TYPE = 'plugin:dsh-quip/purged'
/**
 * 兜底句的 producer kind。`MessageSourceMap` 是 merge-extensible 的（session v4 起没有
 * catch-all 的 `plugin` kind），每个 producer 自有一个 kind——dsh-rewind 的 marker 用
 * `{kind:'dsh-rewind'}`，这里同理。兜底句不是模型生成的，`message.source` 不能写
 * `kind:'model'` 再挂 provider/model；用本插件的包名作 kind，不带任何模型归属字段。
 */
const FALLBACK_SOURCE_KIND = PLUGIN_TAG
/**
 * 辅助模型调用的分类标识，透传给 `llm.stream({ purpose })`（DSH 为辅助调用预留的
 * 字段，adapters 可映射到传输层元数据），同时写进 record，让下游能按用途筛选。
 */
const CALL_PURPOSE = 'dsh-quip/generate'
/** plugin record 类型语法（与 dsh-session 的 PLUGIN_RECORD_TYPE 一致）。 */
const PLUGIN_RECORD_TYPE_RE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/
/** 单次生成调用的默认超时（毫秒）；`QUIP_TIMEOUT_MS` 可覆盖（测试用短超时走到 timeout 路径）。 */
const DEFAULT_GENERATION_TIMEOUT_MS = 30_000

/** 读当前生效的生成超时（运行时读，便于测试与环境覆盖）。 */
function generationTimeoutMs() {
  const raw = Number(process.env.QUIP_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GENERATION_TIMEOUT_MS
}
/** SSE 心跳间隔（毫秒），低于常见代理空闲超时。 */
const SSE_HEARTBEAT_MS = 25_000
/**
 * 生成过程记录：内存保留上限与单文件滚动上限（条）。
 * 磁盘上永久保留、只追加不重写：写满一个文件就换下一个，用户可在设置卡打开
 * 记录目录自行删除；内存只留最近 GEN_MEMORY_LIMIT 条供面板查询。
 */
const GEN_MEMORY_LIMIT = 500
const GEN_FILE_LIMIT = 500
/**
 * 生成过程记录目录（默认 $DSH_HOME/quip/；QUIP_DATA_DIR 可覆盖，测试用）。
 * 记录文件放在其下的 generations/ 子目录，每个文件最多 GEN_FILE_LIMIT 条。
 */
const DATA_DIR = process.env.QUIP_DATA_DIR
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'quip')
const GEN_DIR = join(DATA_DIR, 'generations')
/** 旧版单文件布局；首次启动时整体迁移进 GEN_DIR（不解析、不改内容）。 */
const LEGACY_GEN_FILE = join(DATA_DIR, 'generations.jsonl')
/** 文件名 = 该文件首条记录的本地时间，按名字排序即时间顺序；迁移撞名时带 -N 后缀。 */
const GEN_FILE_PREFIX = 'generations-'
const GEN_FILE_RE = /^generations-(\d{8}-\d{6})(?:-\d+)?\.jsonl$/
/** 本包版本（health 端点与日志用；与 package.json 同步）。 */
const VERSION = '0.1.0'

// ---- 生成过程记录文件（纯函数，不依赖 ctx） ----

/** 本地时间 YYYYMMDD-HHmmss（文件名用；本地时区与用户在文件管理器里看到的一致）。 */
function generationStamp(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 解析一行生成记录；坏行返回 null。
 * 旧版字段归一化：raw（模型原文）/ cleaned（最终文本）合并为 text（用户最终看到的），
 * 缺 file（所属文件）时补上所在文件名。
 * @param {string} line - 一行 JSON。
 * @param {string} fileName - 所在文件名。
 * @returns {Record<string, unknown> | null}
 */
function parseGenerationLine(line, fileName) {
  let record
  try { record = JSON.parse(line) } catch { return null }
  if (record === null || typeof record !== 'object') return null
  if (typeof record.text !== 'string') {
    record.text = typeof record.cleaned === 'string' ? record.cleaned : typeof record.raw === 'string' ? record.raw : ''
  }
  delete record.raw
  delete record.cleaned
  if (typeof record.file !== 'string' || record.file === '') record.file = fileName
  return record
}

/** 记录目录里的文件名，按时间升序（旧 → 新）；目录不存在时为空。 */
function listGenerationFiles() {
  let names
  try { names = readdirSync(GEN_DIR) } catch { return [] }
  return names.filter((name) => GEN_FILE_RE.test(name)).sort()
}

/**
 * 目录签名：文件名 + 大小 + mtime。用户在文件管理器里增删文件后签名会变，
 * 查询端点据此重载内存缓存，不必重启。
 */
function generationDirSignature() {
  try {
    return listGenerationFiles()
      .map((name) => {
        const stat = statSync(join(GEN_DIR, name))
        return `${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`
      })
      .join('|')
  } catch { return '' }
}

/** 读一个记录文件，返回解析后的记录（追加顺序：旧 → 新）；不可读时为空。 */
function readGenerationFile(name) {
  let text
  try { text = readFileSync(join(GEN_DIR, name), 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = parseGenerationLine(line, name)
    if (record !== null) out.push(record)
  }
  return out
}

/** 从磁盘加载最近 GEN_MEMORY_LIMIT 条（最近在前）：从最新文件倒着读，跨文件凑数。 */
function loadGenerations() {
  const out = []
  for (const name of listGenerationFiles().reverse()) {
    const records = readGenerationFile(name)
    for (let i = records.length - 1; i >= 0 && out.length < GEN_MEMORY_LIMIT; i--) out.push(records[i])
    if (out.length >= GEN_MEMORY_LIMIT) break
  }
  return out
}

/**
 * 旧版单文件 generations.jsonl → 迁移进 GEN_DIR，文件名取首条记录的时间
 * （首行损坏则取文件 mtime）；目标撞名时带 -N 后缀。只 rename，不解析内容。
 * @returns {boolean} 是否发生了迁移。
 */
function migrateLegacyGenerationFile() {
  if (!existsSync(LEGACY_GEN_FILE)) return false
  mkdirSync(GEN_DIR, { recursive: true })
  let stamp = null
  try {
    const firstLine = readFileSync(LEGACY_GEN_FILE, 'utf8').split('\n').find((line) => line.trim() !== '')
    const ts = firstLine === undefined ? NaN : JSON.parse(firstLine)?.ts
    if (Number.isFinite(ts)) stamp = generationStamp(ts)
  } catch { /* 首行损坏：下面退回 mtime */ }
  if (stamp === null) stamp = generationStamp(statSync(LEGACY_GEN_FILE).mtimeMs)
  let target = join(GEN_DIR, `${GEN_FILE_PREFIX}${stamp}.jsonl`)
  for (let n = 2; existsSync(target); n++) target = join(GEN_DIR, `${GEN_FILE_PREFIX}${stamp}-${n}.jsonl`)
  renameSync(LEGACY_GEN_FILE, target)
  return true
}

// ---- 会话日志 plugin record ----

/**
 * 纯函数：从一个会话事件读回 plugin record（任何插件命名空间的）。
 * 与 dsh-session 导出的 `pluginRecordOf` 语义一致——只检查 `ignorable`
 * 标记与类型语法，不触碰任何类，因此不依赖宿主模块实例。
 * @param {{ type?: unknown, ignorable?: unknown, seq?: unknown, time?: unknown, data?: unknown } | null | undefined} event - 会话事件。
 * @returns {{ type: string, seq: unknown, time: unknown, data: unknown } | null}
 */
export function pluginRecordOf(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.ignorable !== true || typeof event.type !== 'string') return null
  if (!PLUGIN_RECORD_TYPE_RE.test(event.type)) return null
  return { type: event.type, seq: event.seq, time: event.time, data: event.data }
}

/**
 * 从一条 record 取出可见文本：原生 `message.content` 里的 text 块。
 * @param {Record<string, unknown>} record - plugin record 的 data。
 * @returns {string}
 */
export function textOfRecord(record) {
  if (record === null || typeof record !== 'object') return ''
  const content = record.message?.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

/**
 * 纯函数：一个会话事件是否为一条俏皮话 record——类型对、带 `ignorable`、`v` 是当前版本、
 * `turn` 是数字、`message.content` 是数组。结构不完整的（清除占位行、损坏行、未来版本）落选。
 * 不触碰任何类，不依赖宿主模块实例。
 * @param {{ type?: unknown, ignorable?: unknown, seq?: unknown, time?: unknown, data?: unknown } | null | undefined} event - 会话事件。
 * @returns {boolean}
 */
export function isCurrentQuipRecord(event) {
  if (event === null || typeof event !== 'object') return false
  if (event.type !== RECORD_TYPE || event.ignorable !== true) return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  return data.v === RECORD_FORMAT_VERSION
    && typeof data.turn === 'number'
    && Array.isArray(data.message?.content)
}

/**
 * 列出宿主 dsh-session 模块的候选 URL，按可信度排序。
 *
 * 实测（2026-11-23）：宿主主进程里**没有** `DSH_INSTALL_DIR`——它只是 DSH 为
 * shell 工具子进程注入的变量。因此这里的候选在宿主内通常为空，只能作为
 * 有该变量时的补充；首选候选由 {@link probeHostSessionUrl} 直接探测得到。
 * 宿主安装目录下 `@deepseek-ai/dsh-session` 是真实目录（扁平打包，无 .pnpm）。
 * @returns {Array<{ label: string, url: string }>}
 */
export function candidateSessionModules() {
  const out = []
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir !== '') {
    try {
      const hostRequire = createRequire(join(installDir, 'package.json'))
      const resolved = hostRequire.resolve('@deepseek-ai/dsh-session')
      out.push({ label: 'host-resolve', url: pathToFileURL(resolved).href })
    } catch { /* 解析失败：退到直接拼路径 */ }
    const direct = join(dirname(installDir), 'dsh-session', 'lib', 'index.js')
    out.push({ label: 'host-asar', url: pathToFileURL(direct).href })
  }
  return out
}

/**
 * 探测宿主 Session 实例的方法定义在哪个源文件。
 * 原理：`session.append(null)` 会在 `#appendEvents` 读取 `null.length` 时抛出
 * TypeError——这发生在 `publicationEntry()` 之后、任何日志修改之前，被拒的
 * 追加不改变日志。用 `Error.prepareStackTrace` 读 CallSite 的脚本 URL 即得
 * 宿主模块的真实 URL。这是诊断「两个模块实例」的唯一进程内手段。
 * @param {object} session - 宿主 Session 实例。
 * @returns {string | null} 宿主 Session 所在源文件的 URL；探测失败为 null。
 */
export function probeHostSessionUrl(session) {
  if (session === null || typeof session !== 'object' || typeof session.append !== 'function') return null
  const previous = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_error, sites) => sites
    try {
      session.append(null)
    } catch (error) {
      const sites = error.stack
      if (!Array.isArray(sites)) return null
      for (const site of sites) {
        let file = null
        try { file = site.getScriptNameOrSourceURL() } catch { /* 该帧无脚本信息 */ }
        if (typeof file === 'string' && file !== '' && /dsh-session/.test(file)) return file
      }
      return null
    }
    return null
  } finally {
    Error.prepareStackTrace = previous
  }
}

/**
 * 把模块 URL 规范化成可比对的形式：file URL 解码为文件路径，其余原样。
 * @param {string | null} url - 模块 URL。
 * @returns {string | null}
 */
function normalizeModuleUrl(url) {
  if (typeof url !== 'string' || url === '') return null
  try { return fileURLToPath(url) } catch { return url }
}

/**
 * 解析可用于写会话日志的 `appendPluginRecord`。
 * 逐个候选 import，记录每个候选的可用性与「是否就是宿主模块实例」的比对结果。
 * 比对依据是探测到的宿主 Session 源 URL 与候选 URL 规范化后是否同一文件。
 * @param {object} session - 宿主 Session 实例（用于探测）。
 * @returns {Promise<{ append: ((s: object, t: string, d: unknown) => unknown) | null, label: string, url: string | null, hostUrl: string | null, match: 'match' | 'mismatch' | 'unverified' | 'none', candidates: Array<Record<string, unknown>> }>}
 */
export async function resolveSessionWriter(session) {
  const hostUrl = probeHostSessionUrl(session)
  const hostNorm = normalizeModuleUrl(hostUrl)
  // 探测到的 URL 就是宿主 ESM loader 加载该模块时用的 URL：import 同一 URL 命中模块缓存，
  // 拿到的一定是宿主实例。它是首选候选，也是唯一不依赖环境变量的候选。
  const candidates = []
  if (typeof hostUrl === 'string' && hostUrl.startsWith('file:')) {
    candidates.push({ label: 'host-probed', url: hostUrl })
  }
  candidates.push(...candidateSessionModules())
  const report = []
  let chosen = null
  for (const candidate of candidates) {
    const entry = { label: candidate.label, url: candidate.url, loaded: false, hasAppend: false, error: null }
    try {
      const mod = await import(candidate.url)
      entry.loaded = true
      entry.hasAppend = typeof mod.appendPluginRecord === 'function'
      if (entry.hasAppend && chosen === null) chosen = { append: mod.appendPluginRecord, ...candidate }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
    }
    entry.sameAsHost = hostNorm === null ? null : normalizeModuleUrl(candidate.url) === hostNorm
    report.push(entry)
  }
  if (chosen === null) {
    return { append: null, label: 'none', url: null, hostUrl, match: 'none', candidates: report }
  }
  const match = hostNorm === null
    ? 'unverified'
    : (normalizeModuleUrl(chosen.url) === hostNorm ? 'match' : 'mismatch')
  return { append: chosen.append, label: chosen.label, url: chosen.url, hostUrl, match, candidates: report }
}

// ---- schemastery ----

// dsh 运行时依赖，零包声明解析；失败则无表单、用默认值
const requireDsh = createRequire(import.meta.url)
let Schema = null
try {
  const mod = requireDsh('@deepseek-ai/schemastery')
  const candidate = mod && mod.default ? mod.default : mod
  if (candidate && typeof candidate === 'function' && typeof candidate.object === 'function') {
    Schema = candidate
  }
} catch {
  /* 无表单环境：插件仍以默认配置运行 */
}

/** 配置 schema：全部 volatile（GUI 改动即时生效，不重启 entry）。 */
export const Config = Schema === null ? undefined : Schema.object({
  enabled: Schema.boolean().default(true).volatile().description('总开关：关闭后不再生成新的俏皮话'),
  style: Schema.union(STYLE_IDS.concat([CUSTOM_STYLE_ID])).default('playful').volatile()
    .description('风格：playful 俏皮 / hype 夸夸 / roast 毒舌自嘲 / calm 冷静自评 / custom 自定义'),
  customPrompt: Schema.string().default('').volatile().role('textarea')
    .description('custom 风格的自定义提示词（描述这句话该用什么人设与语气）'),
  followSessionModel: Schema.boolean().default(true).volatile()
    .description('跟随会话：用本会话当前选中的模型生成（含思考等级）；关闭后改用下面的 provider/model'),
  provider: Schema.string().default('auto').volatile()
    .description('固定 provider（仅 followSessionModel 关闭时生效）：auto（第一个已注册）或 provider id'),
  model: Schema.string().default('auto').volatile()
    .description('生成用的模型：auto、provider/model 或裸 model id'),
  reasoningEffort: Schema.string().default('auto').volatile()
    .description('思考等级：auto（取该模型可选的最低等级）或模型声明的具体等级 id'),
  maxChars: Schema.number().default(64).volatile().min(8).max(200)
    .description('一句话的字数上限（写进系统提示；请求层不设 maxTokens，显示也永不截断）'),
  temperature: Schema.number().default(1.2).volatile().step(0.1).min(0).max(2)
    .description('生成温度（越高越发散）'),
  includeInterrupted: Schema.boolean().default(false).volatile()
    .description('被中断的轮次也尝试生成（素材为已输出的部分）'),
  includeReasoning: Schema.boolean().default(true).volatile()
    .description('素材带上模型的思考过程（脱敏后截断）：自评能引用它内心的犹豫与绕路，更贴切；关闭可省输入 token'),
  fallback: Schema.boolean().default(true).volatile()
    .description('模型调用失败时改用内置兜底池（按风格）'),
  historyPerSession: Schema.number().default(32).volatile().min(4).max(512)
    .description('每个会话在内存中保留的俏皮话条数'),
})

// ---- 工具函数 ----

/**
 * 读一个 volatile 或普通配置字段。
 * schemastery 的 volatile 字段在 config 上是带 `get()` 的盒子；无 schema
 * 环境下 config 是普通对象，字段可能缺省。
 * @template T
 * @param {Record<string, unknown>} config - 插件配置。
 * @param {string} key - 字段名。
 * @param {T} fallback - 缺省值。
 * @returns {T}
 */
function readConfig(config, key, fallback) {
  const value = config?.[key]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const inner = value.get()
      return (inner === undefined || inner === null) ? fallback : inner
    } catch {
      return fallback
    }
  }
  return value === undefined || value === null ? fallback : value
}

/** 当前生效配置的快照。 */
function currentConfig(config) {
  return {
    enabled: readConfig(config, 'enabled', true),
    style: readConfig(config, 'style', 'playful'),
    customPrompt: readConfig(config, 'customPrompt', ''),
    followSessionModel: readConfig(config, 'followSessionModel', true),
    provider: readConfig(config, 'provider', 'auto'),
    model: readConfig(config, 'model', 'auto'),
    reasoningEffort: readConfig(config, 'reasoningEffort', 'auto'),
    maxChars: readConfig(config, 'maxChars', 64),
    temperature: readConfig(config, 'temperature', 1.2),
    includeInterrupted: readConfig(config, 'includeInterrupted', false),
    includeReasoning: readConfig(config, 'includeReasoning', true),
    fallback: readConfig(config, 'fallback', true),
    historyPerSession: readConfig(config, 'historyPerSession', 32),
  }
}

/** 子代理会话不生成：看 header 里的 origin / delegationDepth（header 形态随版本演进，识别不出就不过滤）。 */
function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/** 已注册 provider 列表（容错取 id）。 */
function providerIds(ctx) {
  const providers = typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []
  return (Array.isArray(providers) ? providers : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.id ?? entry.name : entry))
    .filter((id) => typeof id === 'string' && id !== '')
}

/**
 * 解析配置的 provider/model 到一次具体调用路由。
 * @returns {{ provider: string, model: string | undefined } | null} null 表示无可用 provider。
 */
function resolveRoute(ctx, providerConfig, modelConfig) {
  const ids = providerIds(ctx)
  if (ids.length === 0) return null
  let provider = ids[0]
  let model
  if (typeof modelConfig === 'string' && modelConfig !== '' && modelConfig !== 'auto') {
    if (modelConfig.includes('/')) {
      const index = modelConfig.indexOf('/')
      provider = modelConfig.slice(0, index)
      model = modelConfig.slice(index + 1)
      if (!ids.includes(provider)) return null
    } else {
      model = modelConfig
    }
  }
  if (typeof providerConfig === 'string' && providerConfig !== '' && providerConfig !== 'auto') {
    if (!ids.includes(providerConfig)) return null
    provider = providerConfig
  }
  return { provider, model: model || undefined }
}

/** 发送一个 JSON 响应。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读取请求体的 JSON（限制 64 KiB）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 消费一次 llm.stream 调用，拼接全部文本并保留 usage。
 * 契约见 dsh-llm `StreamChunk`：text-delta 增量、usage 计量、finish 终态。
 *
 * signal 中止必须能**打破等待**：只在收到下一个 chunk 后检查 `signal.aborted`
 * 是不够的——模型流在超时后可能永远不再产出，`for await` 会无限挂起，超时
 * 形同虚设。这里把 `iterator.next()` 与 abort 事件 race，中止时立即退出并标记
 * `aborted`，让调用方能区分「超时」与「模型异常」。
 * 终止原因必须完整保留：`finish.reason` 为 `error` 时流可能不抛异常，只把失败写在
 * chunk 上；额度耗尽、鉴权失败这类错误也常以「正常结束但零输出」的形态出现。
 * 只按 `aborted` 判失败会让这些真实失败被当成成功并静默降级到兜底池。
 * @returns {Promise<{ text: string, usage: Record<string, number> | null, aborted: boolean, finishReason: string | null, error: unknown }>}
 */
async function collectStreamResult(stream, signal) {
  let text = ''
  let usage = null
  let aborted = false
  let finishReason = null
  let finishError = null
  const iterator = stream[Symbol.asyncIterator]()
  let onAbort = null
  const abortRace = new Promise((resolve) => {
    if (signal === undefined || signal === null) return
    onAbort = () => resolve({ aborted: true })
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), abortRace])
      if (next === undefined || typeof next !== 'object') break
      if (next.aborted === true) { aborted = true; break }
      if (next.done) break
      const chunk = next.value
      if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      const u = chunk.usage
      usage = {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        ...(Number.isFinite(u.totalTokens) ? { totalTokens: Number(u.totalTokens) } : {}),
        ...(Number.isFinite(u.cacheReadTokens) ? { cacheReadTokens: Number(u.cacheReadTokens) } : {}),
        ...(Number.isFinite(u.cacheWriteTokens) ? { cacheWriteTokens: Number(u.cacheWriteTokens) } : {}),
        ...(Number.isFinite(u.reasoningTokens) ? { reasoningTokens: Number(u.reasoningTokens) } : {}),
      }
      continue
    }
      if (chunk.type === 'finish') {
        const reason = typeof chunk.reason === 'string' ? chunk.reason : null
        finishReason = reason
        if (reason === 'aborted' || reason === 'error') aborted = reason === 'aborted'
        // DSH 的 finish chunk 可能带 error（adapter 把失败规范化到这里）
        if (chunk.error !== undefined && chunk.error !== null) finishError = chunk.error
        if (reason === 'error' && finishError === null) finishError = new Error(`model stream finished with reason "error"`)
        break
      }
    }
  } finally {
    if (onAbort !== null && signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
    // 让生成器执行自己的清理（关闭底层请求等）。不 await：对一个正挂在 await 上的
    // async generator，return() 会排队到那个 await 之后，等它就等于没超时。
    try {
      const returned = iterator.return?.()
      if (returned !== undefined && typeof returned.catch === 'function') returned.catch(() => {})
    } catch { /* 迭代器已关闭 */ }
  }
  return { text, usage, aborted, finishReason, error: finishError }
}

/** 错误对象的可读文本（带栈的前三帧，便于在 health 里看到真实失败位置）。 */
function describeError(error) {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error), stack: null }
  const frames = typeof error.stack === 'string'
    ? error.stack.split('\n').slice(1, 4).map((line) => line.trim())
    : []
  return { name: error.name, message: error.message, stack: frames.length > 0 ? frames.join(' | ') : null }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {Record<string, unknown>} config - 插件配置。
 */
export function apply(ctx, config) {
  /** @type {Map<string, Array<Record<string, unknown>>>} 每会话俏皮话（内存缓存；持久层真相源是会话日志 plugin record）。 */
  const quips = new Map()
  /** @type {Map<string, import('./quip-lib.js').TurnMaterial>} 进行中一轮的素材折叠器。 */
  const folding = new Map()
  /** @type {Map<string, Set<import('node:http').ServerResponse>>} 每会话 SSE 订阅者。 */
  const watchers = new Map()
  /**
   * @type {Map<string, { provider: string, model: string, reasoningEffort?: string }>}
   * 每会话当前选中的模型（跟随 `model/selection` 事件维护）。会话切模型时用户看到的是
   * 哪个模型，俏皮话就用哪个——这样口径一致，也避免插件固定用一个可能没额度的模型。
   */
  const sessionModels = new Map()
  /** 进行中的生成任务（防同轮重复）。 */
  const generating = new Set()
  /**
   * 生成过程记录（内存，最近在前）：启动从磁盘加载最近 GEN_MEMORY_LIMIT 条，
   * 查询端点发现目录变化（用户增删文件）时重载。磁盘上按文件永久保留。
   */
  let generations = []
  /** 上次加载时的目录签名；与现状不一致就重载。 */
  let generationSignature = ''
  /** 当前写入文件 { name, count }；首次写入时从目录恢复。 */
  let generationSink = null
  /** 会话日志写入器：首次需要时解析并缓存。 */
  let writerPromise = null
  // 旧版单文件先整体搬进记录目录（只 rename），再加载；迁移失败不阻塞，旧文件原样保留
  let migratedLegacy = false
  try {
    migratedLegacy = migrateLegacyGenerationFile()
  } catch (error) {
    ctx.logger.warn(`${PLUGIN_TAG}: legacy generation log not migrated (%s): %s`,
      describeError(error).name, describeError(error).message)
  }
  generations = loadGenerations()
  generationSignature = generationDirSignature()
  ctx.logger.info(`${PLUGIN_TAG}: loaded ${generations.length} generation records from ${listGenerationFiles().length} file(s)${migratedLegacy ? ' (legacy file migrated)' : ''}`)

  /**
   * 会话日志写入的可观测状态。持久化失败曾被 debug 级日志静默吞掉，
   * 这里显式计数并把最近一次错误经 health 端点暴露出来。
   */
  const persistence = {
    /** 写入器解析结果：none / pending / 已解析的候选 label。 */
    writerLabel: 'pending',
    /** 候选模块 URL 与宿主 Session 源 URL 的比对：match / mismatch / unverified / none / pending。 */
    instanceMatch: 'pending',
    /** 探测到的宿主 Session 源 URL（诊断用）。 */
    hostSessionUrl: null,
    /** 选中的模块 URL（诊断用）。 */
    writerUrl: null,
    /** 每个候选的加载报告（诊断用）。 */
    candidates: [],
    /** 成功写入会话日志的 record 条数。 */
    appended: 0,
    /** 写入失败次数。 */
    failed: 0,
    /** 最近一次失败的错误。 */
    lastError: null,
  }

  /** 当前写入文件：接着目录里最新的文件写（不足 GEN_FILE_LIMIT 条），否则下一条新建。 */
  function resolveGenerationSink() {
    const latest = listGenerationFiles().at(-1)
    if (latest !== undefined) {
      const count = readGenerationFile(latest).length
      if (count < GEN_FILE_LIMIT) return { name: latest, count }
    }
    return { name: null, count: GEN_FILE_LIMIT }
  }

  /**
   * 追加一条生成记录：写进当前文件，写满就换一个新文件（文件名 = 这条记录的时间）。
   * 磁盘只追加、不重写；内存只留最近 GEN_MEMORY_LIMIT 条。
   * 落盘失败必须可见——它和会话日志写入失败一样，是「用户要的数据没写进去」。
   * @param {Record<string, unknown>} record - 完整生成过程；写入前补上 file（所属文件名）。
   */
  function recordGeneration(record) {
    try {
      mkdirSync(GEN_DIR, { recursive: true })
      generationSink ??= resolveGenerationSink()
      if (generationSink.name === null || generationSink.count >= GEN_FILE_LIMIT) {
        generationSink = { name: `${GEN_FILE_PREFIX}${generationStamp(record.ts)}.jsonl`, count: 0 }
      }
      record.file = generationSink.name
      appendFileSync(join(GEN_DIR, generationSink.name), `${JSON.stringify(record)}\n`)
      generationSink.count += 1
      generations.unshift(record)
      if (generations.length > GEN_MEMORY_LIMIT) generations.length = GEN_MEMORY_LIMIT
      generationSignature = generationDirSignature()
    } catch (error) {
      ctx.logger.warn(`${PLUGIN_TAG}: generation log append failed (%s): %s`,
        describeError(error).name, describeError(error).message)
    }
  }

  /** 目录变了（用户在文件管理器里增删文件）就从磁盘重载内存缓存；写入游标一并重解析。 */
  function reconcileGenerations() {
    const signature = generationDirSignature()
    if (signature === generationSignature) return
    generations = loadGenerations()
    generationSignature = signature
    generationSink = null
  }

  /**
   * 首次调用时解析会话日志写入器并缓存；之后直接复用。
   * @param {object} session - 宿主 Session 实例。
   */
  function ensureWriter(session) {
    if (writerPromise === null) {
      writerPromise = resolveSessionWriter(session).then((result) => {
        persistence.writerLabel = result.label
        persistence.instanceMatch = result.match
        persistence.hostSessionUrl = result.hostUrl
        persistence.writerUrl = result.url
        persistence.candidates = result.candidates
        if (result.append === null) {
          ctx.logger.warn(`${PLUGIN_TAG}: no dsh-session writer available — quips stay in memory only`)
        } else if (result.match === 'mismatch') {
          ctx.logger.warn(`${PLUGIN_TAG}: dsh-session module instance mismatch — writer=%s host=%s; appends will fail`,
            result.url, result.hostUrl)
        } else {
          ctx.logger.info(`${PLUGIN_TAG}: session writer resolved (%s, %s)`, result.label, result.match)
        }
        return result
      })
    }
    return writerPromise
  }

  /**
   * 写会话日志 plugin record（持久层真相源）。
   * record 携带 token usage：任何遍历会话事件的统计工具都能取到。
   * 失败不抛：计数 + 记录 + warn，俏皮话本身已进内存与 SSE。
   * @param {object} session - 宿主 Session 实例。
   * @param {Record<string, unknown>} record - 要写进会话日志的 record data。
   * @returns {Promise<number | null>} record 在会话日志里的 seq（定位到那一行的坐标）；写入器缺失或失败为 null。
   */
  async function persistQuip(session, record) {
    const writer = await ensureWriter(session)
    if (writer.append === null) {
      persistence.failed += 1
      persistence.lastError = { name: 'NO_WRITER', message: 'no dsh-session module available', stack: null }
      return null
    }
    try {
      const seq = writer.append(session, RECORD_TYPE, record)
      persistence.appended += 1
      return typeof seq === 'number' ? seq : null
    } catch (error) {
      persistence.failed += 1
      persistence.lastError = describeError(error)
      ctx.logger.warn(`${PLUGIN_TAG}: plugin record append failed (%s: %s) — quip kept in memory only: %s`,
        persistence.lastError.name, persistence.lastError.message, persistence.lastError.stack ?? '')
      return null
    }
  }

  /**
   * 内存环形上限裁剪 + SSE 推送 + 写会话日志。
   *
   * 两种形态：`record` 是写进会话日志的持久数据，不含时间——时间由 DSH 写在外层
   * `event.time` 上，再存一份就是冗余。`entry` 是内存/SSE 里的运行时对象，在 record
   * 上补一个 `time`（写入时刻），让 client 的悬停时间在「刚生成」和「冷读恢复」
   * 两种来源下都有值可读。
   * @param {object} session - 宿主 Session 实例。
   * @param {Record<string, unknown>} record - 要写进会话日志的 record data。
   * @returns {Promise<number | null>} 写入完成后的 record seq（见 {@link persistQuip}）。
   */
  function pushQuip(session, record) {
    const sessionId = session.id
    // 运行时 entry = record + client 渲染所需的派生字段（text/source 方便直接读，
    // 不必让 client 了解原生 message.content 的嵌套）
    const entry = {
      ...record,
      text: textOfRecord(record),
      source: record.plugin?.source ?? null,
      time: Date.now(),
    }
    let list = quips.get(sessionId)
    if (list === undefined) {
      list = []
      quips.set(sessionId, list)
    }
    list.push(entry)
    const limit = Math.max(4, Math.round(currentConfig(config).historyPerSession) || 32)
    while (list.length > limit) list.shift()
    broadcast(sessionId, entry)
    // 调用方 await 它拿到 seq 写进生成记录；内存与 SSE 已推送，不依赖写入成败
    const persisted = persistQuip(session, record)
    ctx.logger.debug(`${PLUGIN_TAG}: session %s turn %s quip "%s"`, sessionId, record.turn, record.text)
    return persisted
  }
  /**
   * 从会话日志恢复一个会话的俏皮话（冷读：readSession 扫 plugin record）。
   * @returns {Promise<Array<Record<string, unknown>>>} 恢复的列表（可能为空）。
   */
  async function restoreFromLog(sessionId) {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return []
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      const restored = []
      for (const event of events) {
        // 结构不完整的落选：清除占位行、损坏行、未来版本
        if (!isCurrentQuipRecord(event)) continue
        const data = event.data
        const text = textOfRecord(data)
        if (text === '') continue
        // 时间来自外层 event.time（DSH 写入时填），data 里不冗余存
        restored.push({
          ...data,
          text,
          source: data.plugin?.source ?? null,
          time: event.time,
        })
      }
      return restored
    } catch (error) {
      ctx.logger.debug(`${PLUGIN_TAG}: restore from log failed: %s`, describeError(error).message)
      return []
    }
  }

  /** 向一个会话的全部 SSE 订阅者推送一条事件。 */
  function broadcast(sessionId, entry) {
    const set = watchers.get(sessionId)
    if (set === undefined || set.size === 0) return
    const frame = `data: ${JSON.stringify(entry)}\n\n`
    for (const res of set) {
      try {
        res.write(frame)
      } catch {
        set.delete(res)
      }
    }
  }

  /** 兜底池抽取。 */
  function fallbackQuip(styleId) {
    const pool = fallbackPoolOf(styleId)
    return pool[Math.floor(Math.random() * pool.length)]
  }

  /** @type {Map<string, Promise<{ efforts: Array<{ id: string, name: string }>, defaultEffort: string | undefined } | null>>} 模型元数据缓存（插件重载即清空）。 */
  const modelMetaCache = new Map()

  /**
   * 取一个精确模型的思考等级元数据（`reasoning.efforts`）。
   *
   * **必须用 `resolveModelInfo`，不能用 `resolveModel`**：后者在 LlmRuntime 上是基类
   * 占位实现，永远返回不带 `reasoning` 的 `{provider, id, name}`；只有
   * `resolveModelInfo` 会经 `registration(provider).adapter.resolveModel` 走到真正的
   * adapter，拿到声明过的思考等级。DSH 自己的模型选择器用的也是前者。
   * 没有 model id（provider 默认模型）、宿主无此方法或查询失败时返回 null。
   */
  function modelMetaOf(provider, model) {
    const key = `${provider}/${model}`
    let pending = modelMetaCache.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const resolve = typeof ctx.llm.resolveModelInfo === 'function'
          ? ctx.llm.resolveModelInfo.bind(ctx.llm)
          : null
        if (resolve === null) return null
        try {
          const info = await resolve(provider, model)
          const reasoning = info?.reasoning
          if (reasoning === undefined || !Array.isArray(reasoning.efforts)) return { efforts: [], defaultEffort: undefined }
          return {
            efforts: reasoning.efforts
              .filter((effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string')
              .map((effort) => ({ id: effort.id, name: typeof effort.name === 'string' ? effort.name : effort.id })),
            defaultEffort: typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined,
          }
        } catch {
          return null
        }
      })()
      modelMetaCache.set(key, pending)
    }
    return pending
  }

  /**
   * 决定本次调用传给 llm.stream 的 reasoningEffort。
   * `auto` = 该模型声明等级里最低的一个（efforts 按 adapter 从低到高排列；俏皮话不需要深思考）；
   * 其余按配置原样透传，由 adapter 校验。模型无等级信息时不传，走 provider 默认。
   * @returns {Promise<string | undefined>}
   */
  async function resolveReasoningEffort(route, configured) {
    if (route === null || typeof route.model !== 'string' || route.model === '') return undefined
    const meta = await modelMetaOf(route.provider, route.model)
    const efforts = meta?.efforts ?? []
    if (efforts.length === 0) return undefined
    if (typeof configured !== 'string' || configured === '' || configured === 'auto') return efforts[0].id
    return configured
  }

  /**
   * 生成一句俏皮话（fire-and-forget；所有异常吞掉并按配置降级）。
   * 每次尝试（含跳过与失败）都会记入生成过程记录。
   * @param {object} session - 宿主 Session 实例（用于写 plugin record）。
   * @param {import('./quip-lib.js').TurnMaterial} material - 本轮素材。
   */
  async function generate(session, material) {
    const sessionId = session.id
    const token = `${sessionId}:${material.turn}`
    if (generating.has(token)) return
    generating.add(token)
    const controller = new AbortController()
    let timedOut = false
    const timeoutMs = generationTimeoutMs()
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    const startedAt = Date.now()
    const conf = currentConfig(config)
    // 跟随会话：会话当前选中的模型就是用户眼前看到的模型，用它生成口径一致；
    // 会话还没记录过选择时才回落到配置的 provider/model。
    const sessionSelection = conf.followSessionModel ? sessionModels.get(sessionId) : undefined
    const route = sessionSelection !== undefined
      ? { provider: sessionSelection.provider, model: sessionSelection.model }
      : resolveRoute(ctx, conf.provider, conf.model)
    // 思考等级：跟随会话时用会话选的等级；否则 auto 取模型可选的最低等级
    const reasoningEffort = sessionSelection?.reasoningEffort !== undefined
      ? sessionSelection.reasoningEffort
      : await resolveReasoningEffort(route, conf.reasoningEffort)
    const systemPrompt = buildSystemPrompt(conf.style, conf.customPrompt, { maxChars: conf.maxChars })
    const materialText = renderMaterial(material, { includeReasoning: conf.includeReasoning })
    /** 会话日志写入的 promise：拿到 seq 后回填 trace.recordSeq，再落生成记录。 */
    let persisted = null
    /** 生成过程记录（成功与失败都记；恢复查看器用）。 */
    const trace = {
      ts: startedAt,
      session: sessionId,
      turn: material.turn,
      // 会话日志定位坐标。step / messageId 在写 record 前确定；recordSeq 由 appendPluginRecord
      // 的返回值回填（写入失败则为 null）。有 recordSeq 就能在会话文件里按 seq 直接命中那一行；
      // 没有（写入失败）时仍可按 turn 找——每轮只写一条 record。
      step: null,
      messageId: null,
      recordSeq: null,
      afterSeq: material.lastAssistantSeq,
      turnEndSeq: material.turnEndSeq,
      style: conf.style,
      // 对齐 DSH request/header.header.config（LlmCallConfig）
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      temperature: conf.temperature,
      // 请求层不设输出上限（见 buildSystemPrompt 的说明）；null 表示「未限制」
      maxTokens: null,
      // 辅助调用分类
      purpose: CALL_PURPOSE,
      /** 路由来源：session（跟随会话选择）/ config（回落到固定配置）。 */
      routeSource: sessionSelection !== undefined ? 'session' : 'config',
      material: materialText.slice(0, 2000),
      systemPrompt,
      /**
       * 用户最终看到的那句话，与写进会话日志的 message.content[0].text 完全相同：
       * 模型生成 → 模型原文（仅去首尾空白，不剥引号、不截首行）；兜底 → 兜底池抽出的那句。
       * 谁产生的看 source；模型失败且未开兜底时为空串，原因看 error。
       */
      text: '',
      /** 所属记录文件名（recordGeneration 写入前填上；面板据此告诉用户去哪删）。 */
      file: null,
      /** 模型调用的结局：ok / timeout / aborted / error / skip / no-provider。 */
      outcome: 'error',
      /** 最终文本的来源：model / fallback / no-provider / skip。 */
      source: 'error',
      usage: null,
      durationMs: 0,
      error: null,
    }
    try {
      let text = ''
      let source = 'fallback'
      if (route !== null) {
        try {
          const result = await collectStreamResult(ctx.llm.stream({
            provider: route.provider,
            model: route.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            purpose: CALL_PURPOSE,
            system: systemPrompt,
            messages: [{
              role: 'user',
              content: [{ type: 'text', text: materialText }],
            }],
            // 不传 maxTokens：GenerateOptions 里它可选，省略即走路由默认值。
            // 长度约束只靠系统提示（曾经硬编码 128，带思考的模型思考没结束就被截断）。
            temperature: conf.temperature,
            signal: controller.signal,
            sessionId,
          }), controller.signal)
          trace.usage = result.usage
          // 流以 error 结束（或带着 error chunk）时，即使没抛异常也必须记失败
          if (result.error !== null && result.error !== undefined) throw result.error
          // 模型原文只去首尾空白：用户要求看到的就是模型真实输出的内容，不再剥引号、不再截首行
          const modelText = typeof result.text === 'string' ? result.text.trim() : ''
          if (result.aborted) {
            trace.outcome = timedOut ? 'timeout' : 'aborted'
            trace.error = timedOut ? `generation exceeded ${timeoutMs} ms` : 'generation aborted'
          } else if (result.text.includes(SKIP_SENTINEL)) {
            // 模型自己判定素材不足：尊重它，不用兜底池；哨兵原文留在 text 里供面板查看。
            trace.outcome = 'skip'
            trace.source = 'skip'
            trace.text = modelText
            return
          } else if (modelText !== '') {
            text = modelText
            source = 'model'
            trace.outcome = 'ok'
          } else {
            // 流正常结束但没有任何可用文本：额度耗尽、鉴权失败、被上游内容策略
            // 拦截等都会长这样。曾把它记成 ok，导致真实失败在生成记录里完全不可见。
            trace.outcome = 'empty'
            trace.error = `model returned no text (finish=${result.finishReason ?? 'none'}, usage=${result.usage === null ? 'none' : JSON.stringify(result.usage)})`
            ctx.logger.warn(`${PLUGIN_TAG}: %s/%s returned no text (finish=%s)`,
              route.provider, route.model ?? '(default)', result.finishReason ?? 'none')
          }
        } catch (error) {
          trace.outcome = 'error'
          trace.error = describeError(error).message
          // 失败必须在默认日志级别可见：额度耗尽/鉴权失败时用户需要知道为什么只剩兜底句
          ctx.logger.warn(`${PLUGIN_TAG}: generation failed (%s): %s`, describeError(error).name, trace.error)
        }
      } else {
        trace.outcome = 'no-provider'
        trace.source = 'no-provider'
        trace.error = 'no registered llm provider'
      }
      if (text === '' && conf.fallback) {
        text = fallbackQuip(conf.style)
        source = route === null ? 'no-provider' : 'fallback'
      }
      if (text !== '') {
        trace.source = source
        trace.text = text
        const durationMs = Date.now() - startedAt
        trace.durationMs = durationMs
        // 写进会话日志的 record：**按 DSH 原生 assistant/message 的形状组织**，
        // 这样任何读会话事件的工具（不限于某个具体的统计器）用同一套逻辑就能解析，
        // 不必为插件记录写专用分支。字段与原生语义一一对应：
        //   turn / step      原生同名字段。step = 本轮最后一个 step/end + 1：quip 在 turn/end
        //                   后才生成，挂在最后一步之后；用下一步的号占位，(turn, step) 就不会
        //                   与本轮任何 assistant/message 同槽——按 token-usage 的
        //                   sessionID:turn:step:attempt 合成 ID 也不撞（它的 attempt 自己从
        //                   llm/retry-started 数，quip 的虚拟步没有 retry 事件 → 0）
        //   message          原生消息体：role/content/source/id。source.kind 说的是「谁产生了
        //                   这句话」：模型生成的才是 model（带 provider/model）；兜底句由本插件
        //                   从内置池抽出，kind 用插件自有的 producer kind，不挂模型归属
        //   usage            TokenUsage 四桶，原样透传（兜底时是那次失败调用的真实用量）
        //   request          原生 request/header.header.config 的等价物（路由与采样参数；
        //                   不设 maxTokens，与请求一致）
        //   after            这条俏皮话评论的是哪条实际回复：本轮最后一条 assistant/message
        //                   的日志 seq 与 message.id，以及 turn/end 的 seq（quip 的直接前驱）
        //   plugin           插件自有元数据，不与原生字段重名。source 区分文本来自模型还是
        //                   兜底池；outcome 记录模型调用本身的结局，让「调了但失败→兜底」
        //                   和「没调→兜底」在日志里可区分
        const quipStep = material.step + 1
        const messageId = `quip-${sessionId}-${material.turn}-${quipStep}-${Date.now().toString(36)}`
        const modelGenerated = source === 'model'
        trace.step = quipStep
        trace.messageId = messageId
        persisted = pushQuip(session, {
          v: RECORD_FORMAT_VERSION,
          turn: material.turn,
          step: quipStep,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
            source: modelGenerated
              ? {
                kind: 'model',
                ...(route?.provider === undefined ? {} : { provider: route.provider }),
                ...(route?.model === undefined ? {} : { model: route.model }),
              }
              : { kind: FALLBACK_SOURCE_KIND },
            id: messageId,
          },
          usage: trace.usage,
          request: {
            provider: route?.provider ?? null,
            model: route?.model ?? null,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            temperature: conf.temperature,
          },
          after: {
            seq: material.lastAssistantSeq,
            messageId: material.lastAssistantMessageId,
            turnEndSeq: material.turnEndSeq,
          },
          plugin: {
            name: PLUGIN_TAG,
            purpose: CALL_PURPOSE,
            style: conf.style,
            source,
            outcome: trace.outcome,
            routeSource: trace.routeSource,
            durationMs,
          },
        })
      }
    } finally {
      if (trace.durationMs === 0) trace.durationMs = Date.now() - startedAt
      // 等 record 真正落进会话日志、拿到 seq 再记生成过程：面板靠 recordSeq 定位到会话文件的那一行。
      // persistQuip 自己吞错并返回 null，这里的 await 只会等到「成功 seq」或「null」。
      if (persisted !== null) trace.recordSeq = await persisted
      recordGeneration(trace)
      clearTimeout(timer)
      generating.delete(token)
    }
  }

  /**
   * 从 `request/header` 事件读实际发出的路由（用户切模型后，真正的选择会在下个请求头里落定）。
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | null}
   */
  function selectionOfHeader(header) {
    const config = header?.config
    if (config === null || typeof config !== 'object') return null
    if (typeof config.provider !== 'string' || config.provider === '') return null
    if (typeof config.model !== 'string' || config.model === '') return null
    return {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    }
  }

  // ---- 事件折叠与触发 ----
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || isSubagentSession(session)) return
    const type = event?.type

    // 模型跟随：`model/selection` 是用户主动切换，`request/header` 是实际请求路由（含 adapter 默认值）
    if (type === 'model/selection') {
      const data = event?.data
      if (data !== null && typeof data === 'object'
        && typeof data.provider === 'string' && data.provider !== ''
        && typeof data.model === 'string' && data.model !== '') {
        sessionModels.set(sessionId, {
          provider: data.provider,
          model: data.model,
          ...(typeof data.reasoningEffort === 'string' && data.reasoningEffort !== ''
            ? { reasoningEffort: data.reasoningEffort }
            : {}),
        })
      }
      return
    }
    if (type === 'request/header') {
      const selection = selectionOfHeader(event?.data?.header)
      if (selection !== null) sessionModels.set(sessionId, selection)
      return
    }

    if (type !== 'turn/start' && type !== 'turn/end'
      && type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/call'
      && type !== 'step/end') return

    if (type === 'turn/start') {
      const material = freshTurnMaterial()
      material.turn = event.data?.turn ?? -1
      material.startedAt = typeof event.time === 'number' ? event.time : Date.now()
      folding.set(sessionId, material)
      return
    }
    if (type === 'turn/end') {
      const material = folding.get(sessionId)
      if (material === undefined) {
        // 内存里没有这一轮的素材：插件在轮次中途重载 / 重启过（folding 被清空）。
        // 从会话日志把这轮的事件补折回来，否则这一轮的俏皮话就丢了。
        void rebuildMaterialFromLog(session, event.data?.turn).then((rebuilt) => {
          if (rebuilt !== null) finishTurn(session, rebuilt, event)
        })
        return
      }
      folding.delete(sessionId)
      finishTurn(session, material, event)
      return
    }
    const material = folding.get(sessionId)
    if (material !== undefined) foldEvent(material, event)
  })

  /**
   * 轮次收尾：折进 turn/end、按配置与结束原因决定是否生成。
   * @param {object} session - 宿主 Session 实例。
   * @param {import('./quip-lib.js').TurnMaterial} material - 本轮素材（实时折叠或从日志补折）。
   * @param {{ type: string, seq?: number, time?: number, data?: any }} event - 本轮的 turn/end 事件。
   */
  function finishTurn(session, material, event) {
    // 结束原因与 turn/end 的 seq（record.after 的直接前驱锚点）都由 foldEvent 记
    foldEvent(material, event)
    const reason = event.data?.reason?.kind ?? 'completed'
    const conf = currentConfig(config)
    if (!conf.enabled) return
    const interrupted = reason === 'aborted' || reason === 'interrupted'
    if (reason !== 'completed' && !(interrupted && conf.includeInterrupted)) return
    if (!materialWorthQuip(material)) return
    void generate(session, material)
  }

  /**
   * 从会话日志补折一轮素材：找到本轮的 turn/start，把它之后（含本轮 turn/end，若已持久化）
   * 的事件重新 foldEvent 一遍。上一轮的 quip record 等 plugin 事件会被 foldEvent 忽略。
   * @param {object} session - 宿主 Session 实例。
   * @param {unknown} turn - 本轮轮次号。
   * @returns {Promise<import('./quip-lib.js').TurnMaterial | null>} 补折后的素材；日志不可读或找不到本轮时为 null。
   */
  async function rebuildMaterialFromLog(session, turn) {
    if (!Number.isInteger(turn)) return null
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return null
    try {
      const snapshot = await sessionQuery.readSession(session.id)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      let start = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'turn/start' && events[i]?.data?.turn === turn) { start = i; break }
      }
      if (start < 0) return null
      const material = freshTurnMaterial()
      for (let i = start; i < events.length; i++) foldEvent(material, events[i])
      ctx.logger.info(`${PLUGIN_TAG}: material for turn ${turn} rebuilt from session log (${events.length - start} events)`)
      return material
    } catch (error) {
      ctx.logger.warn(`${PLUGIN_TAG}: material rebuild for turn ${turn} failed (%s): %s`,
        describeError(error).name, describeError(error).message)
      return null
    }
  }

  // 清理会话状态（Session 离开注册表时）
  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    folding.delete(sessionId)
    quips.delete(sessionId)
    sessionModels.delete(sessionId)
    const set = watchers.get(sessionId)
    if (set !== undefined) {
      for (const res of set) {
        try {
          res.end()
        } catch { /* 连接已断 */ }
      }
      watchers.delete(sessionId)
    }
  })

  // ---- HTTP 端点 ----
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    /** 从查询串取 session 参数。 */
    const sessionParam = (req) => {
      try {
        const value = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('session')
        return typeof value === 'string' && value !== '' ? value : null
      } catch {
        return null
      }
    }

    // 路由注册必须挂 ctx.effect：entry 重载（dispose 旧 ctx）时先撤销旧路由，
    // 新实例重新注册；否则 webServer 报 duplicate exact route 且新实例激活失败。
    const routeDisposers = []
    const addRoute = (route) => {
      routeDisposers.push(webServer.register(route))
    }

    // health 与 status 匿名：它们只暴露运行态与配置目录，不含用户数据；
    // 进程外（curl、诊断脚本）必须能读到持久化诊断，否则失败又会不可见。
    addRoute({
      kind: 'exact',
      path: `${API_PREFIX}/health`,
      auth: 'anonymous',
      handler: (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          name: PLUGIN_TAG,
          version: VERSION,
          persistence: {
            ...persistence,
            ok: persistence.writerLabel !== 'none' && persistence.writerLabel !== 'pending'
              && persistence.instanceMatch !== 'mismatch' && persistence.failed === 0,
          },
        })
      },
    })

    addRoute({
      kind: 'exact',
      path: `${API_PREFIX}/quips`,
      handler: async (req, res) => {
        const sessionId = sessionParam(req)
        if (sessionId === null) {
          sendJson(res, 400, { error: 'missing session parameter' })
          return
        }
        let list = quips.get(sessionId)
        if (list === undefined) {
          // 内存缓存 miss：从会话日志的 plugin record 恢复（重启/冷会话）。
          list = await restoreFromLog(sessionId)
          quips.set(sessionId, list)
        }
        sendJson(res, 200, { quips: list })
      },
    })

    addRoute({
      kind: 'exact',
      path: `${API_PREFIX}/generations`,
      handler: (req, res) => {
        // 用户可能刚在文件管理器里删了记录文件：目录一变就重载，面板不必等重启
        reconcileGenerations()
        const sessionId = sessionParam(req)
        let limit = 20
        try {
          const value = Number(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('limit'))
          if (Number.isFinite(value) && value > 0) limit = Math.min(GEN_MEMORY_LIMIT, Math.round(value))
        } catch { /* 用默认值 */ }
        const records = (sessionId === null
          ? generations
          : generations.filter((entry) => entry.session === sessionId)).slice(0, limit)
        sendJson(res, 200, { generations: records })
      },
    })

    addRoute({
      kind: 'exact',
      path: `${API_PREFIX}/watch`,
      handler: (req, res) => {
        const sessionId = sessionParam(req)
        if (sessionId === null) {
          sendJson(res, 400, { error: 'missing session parameter' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write('retry: 3000\n\n')
        let set = watchers.get(sessionId)
        if (set === undefined) {
          set = new Set()
          watchers.set(sessionId, set)
        }
        set.add(res)
        req.on('close', () => {
          set.delete(res)
          if (set.size === 0) watchers.delete(sessionId)
        })
      },
    })

    addRoute({
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      auth: 'anonymous',
      handler: async (_req, res) => {
        const conf = currentConfig(config)
        const providers = []
        for (const id of providerIds(ctx)) {
          const entry = { id, models: [] }
          try {
            const models = await ctx.llm.listModels(id)
            const ids = (Array.isArray(models) ? models : [])
              .map((item) => (item && typeof item === 'object' ? { id: item.id ?? item.model ?? item.name, name: item.name } : { id: item, name: undefined }))
              .filter((item) => typeof item.id === 'string' && item.id !== '')
            // 每个模型附带可选思考等级（设置卡下拉用）；单个模型查不到不影响其他
            entry.models = await Promise.all(ids.map(async ({ id: modelId, name }) => {
              const meta = await modelMetaOf(id, modelId)
              return {
                id: modelId,
                name: typeof name === 'string' && name !== '' ? name : modelId,
                efforts: meta?.efforts ?? [],
                defaultEffort: meta?.defaultEffort,
              }
            }))
          } catch { /* 单个 provider 失败不拖垮整个目录 */ }
          providers.push(entry)
        }
        /**
         * 记录目录的真实路径：面板「打开记录文件夹」把它交给宿主在系统文件管理器里打开。
         * 必须 realpath——宿主要求路径解析后与传入值一致，符号链接会被拒；目录不可用时为 null（按钮禁用）。
         */
        let dataDir = null
        try {
          mkdirSync(GEN_DIR, { recursive: true })
          dataDir = realpathSync(GEN_DIR)
        } catch { /* 目录不可用：面板按钮禁用 */ }
        sendJson(res, 200, {
          config: conf,
          providers,
          styles: STYLE_IDS.concat([CUSTOM_STYLE_ID]),
          sessions: quips.size,
          /** 已跟踪到模型选择的会话（followSessionModel 开启时，生成就用这里的模型）。 */
          sessionModels: Object.fromEntries(sessionModels),
          dataDir,
        })
      },
    })

    addRoute({
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const entry = ctx.fiber?.entry
        const editor = ctx.get('configEditor')
        if (entry === undefined || editor === undefined) {
          sendJson(res, 503, { error: 'configuration cannot be saved in this profile' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const patch = body && typeof body === 'object' && body.config && typeof body.config === 'object'
            ? body.config
            : body
          const allowed = ['enabled', 'style', 'customPrompt', 'followSessionModel', 'provider', 'model', 'reasoningEffort', 'maxChars', 'temperature', 'includeInterrupted', 'includeReasoning', 'fallback', 'historyPerSession']
          const next = {}
          for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
          }
          if (Object.keys(next).length === 0) {
            sendJson(res, 400, { error: 'no recognized fields' })
            return
          }
          await editor.edit(entry, (current) => ({ ...current, ...next }))
          sendJson(res, 200, { config: currentConfig(config) })
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    ctx.effect(() => () => {
      for (const dispose of routeDisposers) {
        try {
          dispose?.()
        } catch { /* 注册已失效 */ }
      }
    }, `${PLUGIN_TAG}: http routes`)
  }

  // ---- SSE 心跳（单一 interval，随插件卸载清理） ----
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const set of watchers.values()) {
        for (const res of set) {
          try {
            res.write(': ping\n\n')
          } catch { /* 写失败由 close 回调清理 */ }
        }
      }
    }, SSE_HEARTBEAT_MS)
    return () => {
      clearInterval(timer)
      for (const set of watchers.values()) {
        for (const res of set) {
          try {
            res.end()
          } catch { /* 连接已断 */ }
        }
      }
      watchers.clear()
    }
  }, `${PLUGIN_TAG}: sse heartbeat`)

  ctx.logger.info(`${PLUGIN_TAG}: host half active v%s (providers=%s)`, VERSION, providerIds(ctx).join(',') || 'none')
}
