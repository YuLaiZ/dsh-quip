#!/usr/bin/env node
/**
 * 清除 dsh-quip 的全部历史俏皮话记录（一次性迁移工具，0.6.0 清零时用过）。
 *
 * 做两件事：
 *  1. 会话日志里不是当前格式的 `plugin:dsh-quip/quip` record → 原地替换为 `plugin:dsh-quip/purged`
 *     空记录，外层 seq / time 保留。DSH 读回要求每个事件的 seq 严格等于行号，直接删行会让会话
 *     打不开，所以只能原位清空内容。当前格式（`data.v === 1` 且 `message.content` 是数组）保留。
 *  2. 插件自有的生成过程记录（旧版单文件 `generations.jsonl`、新版目录 `generations/`）→ 整体移入备份。
 *
 * 先备份原文件；重写后再解压读一遍，核对行数与 seq 连续性。
 *
 * 关键：DSH 的会话日志是**多帧** zstd 文件，第一帧必须恰好只有 session header 那一行。
 * 所以重写时必须把 header 行和其余内容**分别压成两帧**再拼接；用单次 `zstd -c` 把整个文件
 * 压成一帧会让 DSH 判读失败（first frame is not exactly one header line），随后该会话
 * 会被静默跳过并从工作区列表里消失。写完必须校验帧结构，不能只校验行数。
 *
 * 用法：
 *   node scripts/purge-legacy-records.mjs --dry-run          # 只报告
 *   node scripts/purge-legacy-records.mjs                    # 执行
 *   可选：--sessions-root <dir>  --data-dir <dir>  --no-backup
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const QUIP_TYPE = 'plugin:dsh-quip/quip'
const PURGED_TYPE = 'plugin:dsh-quip/purged'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const DRY_RUN = flag('--dry-run')
const NO_BACKUP = flag('--no-backup')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS_ROOT = option('--sessions-root', join(DSH_HOME, 'sessions'))
const DATA_DIR = option('--data-dir', join(DSH_HOME, 'quip'))
const BACKUP_ROOT = join(DSH_HOME, 'quip-purge-backup', new Date().toISOString().replace(/[:.]/g, '-'))

const isCurrent = (data) => data !== null && typeof data === 'object'
  && data.v === 1 && Array.isArray(data.message?.content)

const zstd = (cliArgs, input) => {
  const result = spawnSync('zstd', cliArgs, { input, encoding: 'buffer', maxBuffer: 1 << 30 })
  if (result.status !== 0) throw new Error(`zstd ${cliArgs.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout
}

/**
 * 数一个 zstd 文件里有多少个完整的帧。只按帧头/块头走一遍结构，不解压。
 * 用来确认重写后仍是「header 独占首帧」的多帧文件。
 */
const countZstdFrames = (buffer) => {
  const ZSTD_MAGIC = 4247762216
  let offset = 0
  let frames = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`torn zstd frame at byte ${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) throw new Error(`torn zstd frame at byte ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved zstd frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn zstd frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error(`torn zstd frame at byte ${start}`)
    frames += 1
  }
  return frames
}

const collectLogs = (dir, out) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectLogs(path, out)
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) out.push(path)
  }
  return out
}

const copyBackup = (file) => {
  if (NO_BACKUP) return null
  const target = join(BACKUP_ROOT, relative(dirname(SESSIONS_ROOT), file))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(file))
  return target
}

const purgeLog = (file) => {
  const lines = zstd(['-dc', file]).toString('utf8').split('\n')
  const trailingNewline = lines[lines.length - 1] === ''
  if (trailingNewline) lines.pop()
  let purged = 0
  let kept = 0
  const out = lines.map((line) => {
    let event
    try { event = JSON.parse(line) } catch { return line }
    if (event.type !== QUIP_TYPE) return line
    if (isCurrent(event.data)) { kept += 1; return line }
    purged += 1
    return JSON.stringify({ type: PURGED_TYPE, seq: event.seq, time: event.time, data: {}, ignorable: true })
  })
  if (purged === 0 || DRY_RUN) return { file, purged, kept }

  copyBackup(file)
  const tmp = `${file}.purge-tmp`
  // 帧 1 = header 行，帧 2 = 其余内容：拆开压缩才能满足 DSH 的首帧约定。
  const headerLine = out[0]
  const rest = out.slice(1).join('\n') + (trailingNewline ? '\n' : '')
  const framed = Buffer.concat([
    zstd(['-q', '-3', '-c'], Buffer.from(headerLine + '\n', 'utf8')),
    zstd(['-q', '-3', '-c'], Buffer.from(rest, 'utf8')),
  ])
  writeFileSync(tmp, framed)
  // 自检 1：帧结构必须多帧，且首帧解压后恰好只有 header 一行
  const frameCount = countZstdFrames(readFileSync(tmp))
  if (frameCount < 2) throw new Error(`${file}: rebuilt log has ${frameCount} zstd frame(s); DSH requires the header in its own leading frame`)
  // 自检 2：解压回来行数一致，且每个事件的 seq === 行号 - 1（首行是 session header）
  const verify = zstd(['-dc', tmp]).toString('utf8').split('\n')
  if (verify[verify.length - 1] === '') verify.pop()
  if (verify.length !== lines.length) throw new Error(`${file}: line count changed (${lines.length} → ${verify.length})`)
  for (let i = 1; i < verify.length; i += 1) {
    const seq = JSON.parse(verify[i]).seq
    if (seq !== i - 1) throw new Error(`${file}: seq not contiguous at line ${i + 1} (seq ${seq})`)
  }
  renameSync(tmp, file)
  return { file, purged, kept }
}

// ---- main ----
let scanned = 0
let totalPurged = 0
let totalKept = 0
for (const file of existsSync(SESSIONS_ROOT) ? collectLogs(SESSIONS_ROOT, []) : []) {
  const result = purgeLog(file)
  scanned += 1
  totalPurged += result.purged
  totalKept += result.kept
  if (result.purged > 0) console.log(`${DRY_RUN ? '[dry-run] ' : ''}${relative(SESSIONS_ROOT, file)}: purged ${result.purged}, kept ${result.kept}`)
}

// 旧版是数据目录下的单文件，新版是其下的 generations/ 目录；两者都整体搬走，不逐行解析
for (const name of ['generations.jsonl', 'generations']) {
  const genPath = join(DATA_DIR, name)
  if (!existsSync(genPath)) continue
  if (DRY_RUN) { console.log(`[dry-run] would remove ${genPath}`); continue }
  if (NO_BACKUP) renameSync(genPath, genPath + '.trash')
  else {
    mkdirSync(BACKUP_ROOT, { recursive: true })
    renameSync(genPath, join(BACKUP_ROOT, name))
  }
  console.log(`removed ${genPath}`)
}

console.log('')
console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned} session logs: purged ${totalPurged} legacy records, kept ${totalKept} current records`)
if (!DRY_RUN && !NO_BACKUP && totalPurged > 0) console.log(`backup: ${BACKUP_ROOT}`)
