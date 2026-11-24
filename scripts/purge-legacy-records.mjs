#!/usr/bin/env node
/**
 * 清除 dsh-quip 的全部历史俏皮话记录（一次性迁移工具，0.6.0 清零时用过）。
 *
 * 做两件事：
 *  1. 会话日志里不是当前格式的 `plugin:dsh-quip/quip` record → 原地替换为 `plugin:dsh-quip/purged`
 *     空记录，外层 seq / time 保留。DSH 读回要求每个事件的 seq 严格等于行号，直接删行会让会话
 *     打不开，所以只能原位清空内容。当前格式（`data.v === 1` 且 `message.content` 是数组）保留。
 *  2. 插件自有的 `generations.jsonl`（生成过程记录）→ 删除。
 *
 * 先备份原文件；重写后再解压读一遍，核对行数与 seq 连续性。
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
  const body = Buffer.from(out.join('\n') + (trailingNewline ? '\n' : ''), 'utf8')
  writeFileSync(tmp, zstd(['-q', '-3', '-c'], body))
  // 自检：解压回来行数一致，且每个事件的 seq === 行号 - 1（首行是 session header）
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

const genFile = join(DATA_DIR, 'generations.jsonl')
if (existsSync(genFile)) {
  if (DRY_RUN) console.log(`[dry-run] would remove ${genFile}`)
  else {
    if (NO_BACKUP) renameSync(genFile, genFile + '.trash')
    else {
      mkdirSync(BACKUP_ROOT, { recursive: true })
      renameSync(genFile, join(BACKUP_ROOT, 'generations.jsonl'))
    }
    console.log(`removed ${genFile}`)
  }
}

console.log('')
console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned} session logs: purged ${totalPurged} legacy records, kept ${totalKept} current records`)
if (!DRY_RUN && !NO_BACKUP && totalPurged > 0) console.log(`backup: ${BACKUP_ROOT}`)
