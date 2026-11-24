#!/usr/bin/env node
/**
 * 修复被“整文件重压成单一 zstd 帧”破坏的 DSH 会话日志（一次性运维脚本）。
 *
 * 背景：DSH 的会话日志是**多帧** zstd 文件，第一帧必须**恰好只有 session header 那一行**，
 * 之后每个持久化批次追加一帧。若有工具把整个文件解压、改内容后用 `zstd -c` 一次压回去，
 * header 和所有事件就被压进同一帧。DSH 扫描会话时会在这个断言上失败：
 *   corrupt Zstandard session log: first frame is not exactly one header line
 * 该会话随即被静默跳过（不报错、不纳入索引），之后任意一次工作区写入都会把它当作
 * “不再归属”从 sessionIds 里剪掉，界面上就表现为会话消失（文件其实还在）。
 *
 * 本脚本只重新打包帧结构：帧 1 = header 行、帧 2 = 其余全部内容，并逐字节校验明文未变。
 * 不修改任何事件内容，也不删除任何行。
 *
 * 用法（必须先退出 DSH）：
 *   node scripts/repair-zstd-frames.mjs --dry-run   # 只体检，报告哪些文件需要修
 *   node scripts/repair-zstd-frames.mjs             # 执行修复
 *   可选：--sessions-root <dir>  --no-backup
 *
 * 为什么要求退出 DSH：工作区账本在 DSH 内存里，替换文件后它不会重新索引；
 * 而且运行中的会话仍可能继续 append，重启一次再修最稳。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const BACKUP_ROOT = join(DSH_HOME, 'zstd-frame-repair-backup', new Date().toISOString().replace(/[:.]/g, '-'))

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const DRY_RUN = flag('--dry-run')
const NO_BACKUP = flag('--no-backup')
const SESSIONS_ROOT = option('--sessions-root', join(DSH_HOME, 'sessions'))

/** 与 DSH 相同：只认完整帧，遇到截断就停下，返回每帧的 [start, end) 字节区间。 */
const scanFrames = (buffer, maxFrames = Number.POSITIVE_INFINITY) => {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** DSH 的首帧断言：首帧解压后必须恰好以单个换行结尾，即只有一行。 */
const headerFrameOk = (plaintext) => plaintext.length > 0 && plaintext.indexOf(10) === plaintext.length - 1

/** 体检：ok=true 表示首帧合规，无需修复。 */
const inspect = (file) => {
  const buffer = readFileSync(file)
  let frames
  try { frames = scanFrames(buffer).frames } catch (error) {
    return { ok: false, reason: `frame scan failed: ${error.message}`, frames: 0 }
  }
  if (frames.length === 0) return { ok: false, reason: 'no complete frame', frames: 0 }
  let first
  try { first = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)) } catch (error) {
    return { ok: false, reason: `first frame decompress failed: ${error.message}`, frames: frames.length }
  }
  if (!headerFrameOk(first)) return { ok: false, reason: 'first frame is not exactly one header line', frames: frames.length }
  return { ok: true, reason: '', frames: frames.length }
}

/**
 * 重新打包：帧 1 = header 行（含换行），帧 2 = 其余全部内容。
 * 压缩参数与 DSH 保持一致（写 crc 校验），并在返回前逐字节核对明文。
 */
const repack = (file) => {
  const original = readFileSync(file)
  const plaintext = zstdDecompressSync(original)
  const newline = plaintext.indexOf(10)
  // 明文第一行必须是可解析的 session header；这里只做结构守卫，不替代 DSH 的完整校验。
  if (newline <= 0) throw new Error(`${file}: plaintext has no complete header line`)
  let header
  try { header = JSON.parse(plaintext.subarray(0, newline).toString('utf8')) } catch {
    throw new Error(`${file}: first plaintext line is not valid JSON`)
  }
  if (header?.type !== 'session') throw new Error(`${file}: first plaintext line is not a session header`)
  const headerLine = plaintext.subarray(0, newline + 1)
  const rest = plaintext.subarray(newline + 1)
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const rebuilt = Buffer.concat([zstdCompressSync(headerLine, options), zstdCompressSync(rest, options)])
  const { frames, tornStart } = scanFrames(rebuilt)
  if (tornStart !== undefined) throw new Error(`${file}: rebuilt file has a torn tail`)
  if (!headerFrameOk(zstdDecompressSync(rebuilt.subarray(frames[0].start, frames[0].end)))) {
    throw new Error(`${file}: rebuilt header frame still fails the assertion`)
  }
  const joined = Buffer.concat(frames.map((frame) => zstdDecompressSync(rebuilt.subarray(frame.start, frame.end))))
  if (!joined.equals(plaintext)) throw new Error(`${file}: plaintext changed during repack`)
  return { rebuilt, frames: frames.length, originalBytes: original.length, rebuiltBytes: rebuilt.length }
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

// ---- main ----
let scanned = 0
let broken = 0
let repaired = 0
let failed = 0
for (const file of existsSync(SESSIONS_ROOT) ? collectLogs(SESSIONS_ROOT, []) : []) {
  scanned += 1
  const result = inspect(file)
  if (result.ok) continue
  broken += 1
  const label = relative(SESSIONS_ROOT, file)
  if (DRY_RUN) {
    console.log(`[dry-run] ${label} | ${result.reason}`)
    continue
  }
  try {
    const { rebuilt, frames, originalBytes, rebuiltBytes } = repack(file)
    if (!NO_BACKUP) {
      const target = join(BACKUP_ROOT, label)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, readFileSync(file))
    }
    const tmp = `${file}.repair-tmp`
    writeFileSync(tmp, rebuilt)
    renameSync(tmp, file)
    repaired += 1
    console.log(`${label} | repaired: ${originalBytes} -> ${rebuiltBytes} bytes, ${frames} frames`)
  } catch (error) {
    failed += 1
    console.error(`${label} | FAILED: ${error.message}`)
  }
}

console.log('')
console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned} session logs: ${broken} need repair, ${repaired} repaired, ${failed} failed`)
if (!DRY_RUN && failed === 0 && !NO_BACKUP && repaired > 0) console.log(`backup: ${BACKUP_ROOT}`)
if (failed > 0) process.exitCode = 1
