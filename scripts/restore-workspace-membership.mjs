#!/usr/bin/env node
/**
 * 把“磁盘上有会话文件、但不在任何工作区账本里且未归档”的会话重新挂回所属工作区。
 *
 * 背景：DSH 的工作区记录（~/.dsh/storages/workspace.json 的 tables.workspaces[*].sessionIds）
 * 是界面列表的唯一来源。会话一旦因会话文件判读失败而不在内存索引里，任意一次工作区写入
 * （新建会话、改名等）都会把它当作“不再归属”剪掉。文件本身不会删，但界面上就消失了。
 *
 * 本脚本按会话 header 里的 cwd 找到所属工作区，把缺失的 id 补回 sessionIds 末尾，
 * 并写回同一份 JSON（2 空格缩进 + 末尾换行，与 DSH 的存储格式一致）。
 *
 * 前提：DSH 必须已退出。工作区记录在 DSH 内存里，运行中改文件会被它下一次写入覆盖。
 *
 * 用法：
 *   node scripts/restore-workspace-membership.mjs --dry-run   # 只报告差异
 *   node scripts/restore-workspace-membership.mjs             # 执行
 *   可选：--sessions-root <dir>  --storage <workspace.json 路径>  --only-workspace <路径>  --no-backup
 *
 * 写回前会把原 workspace.json 备份到 ~/.dsh/workspace-restore-backup/<时间戳>/。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const DRY_RUN = flag('--dry-run')
const SESSIONS_ROOT = option('--sessions-root', join(DSH_HOME, 'sessions'))
const STORAGE = option('--storage', join(DSH_HOME, 'storages', 'workspace.json'))
/** 可选：只恢复某个工作区路径下的会话；不传则处理所有工作区。 */
const ONLY_WORKSPACE = option('--only-workspace', undefined)
const NO_BACKUP = flag('--no-backup')
const BACKUP_ROOT = join(DSH_HOME, 'workspace-restore-backup', new Date().toISOString().replace(/[:.]/g, '-'))

/**
 * 只读一次：整段解压后返回 header 与「是否含真人输入」。
 * 空会话（只有 header、没有用户消息）历来就不该出现在列表里，一律跳过，
 * 否则会把历史上从未用过的空壳会话一次性翻出来。
 */
const readSummary = (file) => {
  const plaintext = zstdDecompressSync(readFileSync(file)).toString('utf8')
  const newline = plaintext.indexOf('\n')
  const header = JSON.parse(plaintext.slice(0, newline))
  const hasUserMessage = /"type":"user\/message"[^\n]*?"kind":"user"/.test(plaintext.slice(newline))
  return { header, hasUserMessage }
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

const document = JSON.parse(readFileSync(STORAGE, 'utf8'))
if (document?.unit?.name !== 'workspace') throw new Error(`${STORAGE}: not a workspace storage document`)
const workspaces = document.tables?.workspaces ?? {}
const archived = new Set(document.global?.archivedSessionIds ?? [])

/** sessionId -> workspace id */
const accounted = new Map()
for (const [workspaceId, record] of Object.entries(workspaces)) {
  for (const sessionId of record.sessionIds ?? []) accounted.set(sessionId, workspaceId)
}
/** cwd -> workspace id（只取已删除过、路径仍存在的记录） */
const byPath = new Map()
for (const [workspaceId, record] of Object.entries(workspaces)) byPath.set(record.path, workspaceId)

let scanned = 0
let orphaned = 0
let restored = 0
let emptyShells = 0
const restoredByWorkspace = new Map()
const unresolved = []

for (const file of existsSync(SESSIONS_ROOT) ? collectLogs(SESSIONS_ROOT, []) : []) {
  scanned += 1
  const sessionId = basename(dirname(file))
  // 子代理会话（无 session- 前缀）本就不进账本，跳过。
  if (!sessionId.startsWith('session-')) continue
  if (accounted.has(sessionId)) continue
  if (archived.has(sessionId)) continue
  orphaned += 1
  let summary
  try { summary = readSummary(file) } catch (error) {
    unresolved.push({ sessionId, reason: `header unreadable: ${error.message}` })
    continue
  }
  const { header, hasUserMessage } = summary
  if (!hasUserMessage) {
    emptyShells += 1
    continue
  }
  const workspaceId = header.cwd === undefined ? undefined : byPath.get(header.cwd)
  if (workspaceId === undefined) {
    unresolved.push({ sessionId, reason: `no workspace owns cwd ${JSON.stringify(header.cwd)}` })
    continue
  }
  if (ONLY_WORKSPACE !== undefined && workspaces[workspaceId].path !== ONLY_WORKSPACE) continue
  if (DRY_RUN) {
    console.log(`[dry-run] ${sessionId} -> ${workspaces[workspaceId].path}`)
    restored += 1
    continue
  }
  const record = workspaces[workspaceId]
  record.sessionIds = [...(record.sessionIds ?? []), sessionId]
  record.updatedAt = new Date().toISOString()
  accounted.set(sessionId, workspaceId)
  restored += 1
  restoredByWorkspace.set(workspaceId, (restoredByWorkspace.get(workspaceId) ?? 0) + 1)
  console.log(`${sessionId} -> ${record.path}`)
}

for (const item of unresolved) console.error(`cannot restore ${item.sessionId}: ${item.reason}`)

if (!DRY_RUN && restored > 0) {
  // 改账本前先留一份原文件：这次改的是全局可见状态，出问题时必须能原样还原。
  if (!NO_BACKUP) {
    mkdirSync(BACKUP_ROOT, { recursive: true })
    writeFileSync(join(BACKUP_ROOT, 'workspace.json.before-restore'), readFileSync(STORAGE))
    console.log(`backup: ${BACKUP_ROOT}`)
  }
  const tmp = `${STORAGE}.restore-tmp`
  writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  // 写回前自检：必须仍能解析，且单位标记未变
  const check = JSON.parse(readFileSync(tmp, 'utf8'))
  if (check?.unit?.name !== 'workspace') throw new Error('refusing to write: document shape changed')
  renameSync(tmp, STORAGE)
}

console.log('')
console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned} session logs: ${orphaned} unaccounted, ${emptyShells} empty shells skipped, ${restored} ${DRY_RUN ? 'would restore' : 'restored'}, ${unresolved.length} unresolved`)
if (!DRY_RUN && restoredByWorkspace.size > 0) {
  for (const [workspaceId, count] of restoredByWorkspace) console.log(`  ${workspaces[workspaceId].path}: +${count}`)
}
if (unresolved.length > 0) process.exitCode = 1
