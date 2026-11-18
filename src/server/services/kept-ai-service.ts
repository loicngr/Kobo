import type { Stats } from 'node:fs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { KEPT_DIR_NAME, keptAiPathOf } from '../../shared/kept-ai.js'
import { logWarn } from '../utils/logger.js'
import { resolveKeptAiBase } from '../utils/worktree-paths.js'
import { getGlobalSettings } from './settings-service.js'
import type { Workspace } from './workspace-service.js'
import { excludeFromProjectGit } from './worktree-service.js'

type KeptAiSource = Pick<Workspace, 'id' | 'projectPath' | 'worktreePath' | 'workingBranch'>
type KeptAiRecord = Pick<Workspace, 'id' | 'worktreePath' | 'worktreePurgedAt' | 'worktreePurgeRestoreData'>
type KeptAiRemoval = KeptAiRecord & Pick<Workspace, 'projectPath' | 'workingBranch'>

const AI_DIR = '.ai'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(target)
  } catch (err) {
    if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') return null
    throw err
  }
}

function isRealDirectory(stat: Stats | null): stat is Stats {
  return stat?.isDirectory() === true && !stat.isSymbolicLink()
}

function keptLocation(workspace: KeptAiSource): { base: string; keptRoot: string } {
  const base = resolveKeptAiBase(
    workspace.projectPath,
    workspace.worktreePath,
    workspace.workingBranch,
    getGlobalSettings().worktreesPath,
  )
  const keptRoot = path.join(base, KEPT_DIR_NAME, workspace.id)
  if (!path.isAbsolute(keptRoot))
    throw new Error(`Cannot resolve a kept folder for worktree '${workspace.worktreePath}'`)
  return { base, keptRoot }
}

export function computeKeptRoot(workspace: KeptAiSource): string {
  return keptLocation(workspace).keptRoot
}

/** Kept root recorded for this workspace AND present on disk, else null. */
export function existingKeptRoot(workspace: KeptAiRecord): string | null {
  if (!workspace.worktreePurgedAt) return null
  const recorded = keptAiPathOf(workspace.id, workspace.worktreePurgeRestoreData)
  if (!recorded) return null
  try {
    const stat = fs.lstatSync(recorded)
    return stat.isDirectory() && !stat.isSymbolicLink() ? recorded : null
  } catch {
    return null
  }
}

/** The kept root at the computed location when it exists as a real directory (not a symbolic link), else null. Never throws: a failure to compute it is logged and gives null. */
export function computedKeptRootIfExists(
  workspace: Pick<Workspace, 'id' | 'projectPath' | 'worktreePath' | 'workingBranch'>,
): string | null {
  let computed: string
  try {
    computed = computeKeptRoot(workspace)
  } catch (err) {
    logWarn('kept-ai', 'Could not compute the kept root', { workspaceId: workspace.id, error: errorMessage(err) })
    return null
  }
  try {
    const stat = fs.lstatSync(computed)
    return stat.isDirectory() && !stat.isSymbolicLink() ? computed : null
  } catch {
    return null
  }
}

/** Root to read the workspace's files from: the kept root while purged with a kept copy, else `worktreePath`. */
export function workspaceFilesRoot(workspace: KeptAiRecord): string {
  return existingKeptRoot(workspace) ?? workspace.worktreePath
}

async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    await fsp.rmdir(dir)
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err
  }
}

/** Moves one entry to a destination that does not exist. Across devices: copy (never overwriting), then remove the source. */
async function moveToFreePath(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest)
    return
  } catch (err) {
    if (errorCode(err) !== 'EXDEV') throw err
  }
  try {
    await fsp.cp(src, dest, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    })
  } catch (err) {
    // dest did not exist before this copy, so removing it only drops our partial copy.
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  await fsp.rm(src, { recursive: true, force: true })
}

const COMPARE_CHUNK = 64 * 1024

/** Fills `buf[0..want)` from `position`, or stops at end of file. Returns the bytes actually read. */
async function readFull(handle: fsp.FileHandle, buf: Buffer, position: number, want: number): Promise<number> {
  let got = 0
  while (got < want) {
    const { bytesRead } = await handle.read(buf, got, want - got, position + got)
    if (bytesRead === 0) break
    got += bytesRead
  }
  return got
}

/** Same size, then exactly the same bytes, read in bounded chunks. Never says "identical" on an error: it throws. */
async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)])
  if (sa.size !== sb.size) return false
  const fa = await fsp.open(a, 'r')
  try {
    const fb = await fsp.open(b, 'r')
    try {
      const bufA = Buffer.alloc(COMPARE_CHUNK)
      const bufB = Buffer.alloc(COMPARE_CHUNK)
      for (let offset = 0; offset < sa.size; offset += COMPARE_CHUNK) {
        const want = Math.min(COMPARE_CHUNK, sa.size - offset)
        const [ra, rb] = [await readFull(fa, bufA, offset, want), await readFull(fb, bufB, offset, want)]
        // A short count before the expected size means the file shrank: different.
        if (ra !== want || rb !== want || !bufA.subarray(0, want).equals(bufB.subarray(0, want))) return false
      }
      return true
    } finally {
      await fb.close()
    }
  } finally {
    await fa.close()
  }
}

/** Renames `dest` to a free `<dest>.kept-<timestamp>` name (counter suffix on collision). */
async function moveAside(dest: string): Promise<void> {
  const base = `${dest}.kept-${Date.now()}`
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`
    if (!(await lstatOrNull(candidate))) {
      await fsp.rename(dest, candidate)
      return
    }
  }
}

/**
 * Moves `src` onto `dest`, merging directories entry by entry (links are never followed).
 * Two regular files with identical content: the moved one is dropped.
 * Anything else that clashes (other content or another type): with `overwrite` the moved entry wins the name and the
 * existing one is renamed aside, otherwise the moved entry stays in place and its path (`rel`) is added to `unplaced`.
 * Nothing is ever deleted unless an identical copy remains.
 */
async function mergeMove(
  src: string,
  dest: string,
  rel: string,
  overwrite: boolean,
  unplaced: string[],
): Promise<void> {
  const srcStat = await fsp.lstat(src)
  const destStat = await lstatOrNull(dest)
  if (!destStat) {
    await moveToFreePath(src, dest)
    return
  }
  if (isRealDirectory(srcStat) && isRealDirectory(destStat)) {
    for (const name of await fsp.readdir(src)) {
      await mergeMove(path.join(src, name), path.join(dest, name), `${rel}/${name}`, overwrite, unplaced)
    }
    await rmdirIfEmpty(src)
    return
  }
  if (srcStat.isFile() && destStat.isFile() && (await sameContent(src, dest))) {
    await fsp.rm(src, { force: true })
    return
  }
  if (!overwrite) {
    unplaced.push(rel)
    return
  }
  await moveAside(dest)
  await moveToFreePath(src, dest)
}

/** Moves `<worktree>/.ai` to the kept root. Returns the kept root when one exists on disk afterwards, else null. Throws on failure, leaving the worktree's `.ai` usable. */
export async function keepAiFolder(workspace: KeptAiSource): Promise<string | null> {
  const { base, keptRoot } = keptLocation(workspace)
  const worktreeAi = path.join(workspace.worktreePath, AI_DIR)

  if (!isRealDirectory(await lstatOrNull(worktreeAi))) {
    return isRealDirectory(await lstatOrNull(keptRoot)) ? keptRoot : null
  }

  // Cheap fallible steps first, so a failure here leaves `.ai` untouched.
  await fsp.mkdir(path.dirname(keptRoot), { recursive: true })
  const keptStat = await lstatOrNull(keptRoot)
  if (keptStat && !isRealDirectory(keptStat)) {
    throw new Error(`Cannot keep the .ai folder: '${keptRoot}' exists and is not a folder`)
  }
  try {
    await excludeFromProjectGit(workspace.projectPath, path.join(base, KEPT_DIR_NAME))
  } catch (err) {
    logWarn('kept-ai', 'Could not exclude the kept folder from the project git', { error: errorMessage(err) })
  }

  let createdRoot = false
  if (!keptStat) {
    // recursive: another workspace's cleanup may have removed the empty `.kobo-kept` meanwhile.
    await fsp.mkdir(keptRoot, { recursive: true })
    createdRoot = true
  }
  try {
    for (const entry of await fsp.readdir(worktreeAi, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.script-')) {
        await fsp.rm(path.join(worktreeAi, entry.name), { recursive: true, force: true })
      }
    }
    await mergeMove(worktreeAi, path.join(keptRoot, AI_DIR), AI_DIR, true, [])
    await rmdirIfEmpty(worktreeAi)
  } catch (err) {
    if (createdRoot) await fsp.rmdir(keptRoot).catch(() => {})
    throw err
  }
  return keptRoot
}

/** Moves `<keptRoot>/.ai` into the worktree without overwriting, then removes the kept root. Returns the relative paths it could not place (type conflicts). Throws on failure. */
export async function putBackAiFolder(keptRoot: string, worktreePath: string): Promise<string[]> {
  const unplaced: string[] = []
  const keptAi = path.join(keptRoot, AI_DIR)
  if (await lstatOrNull(keptAi)) {
    await mergeMove(keptAi, path.join(worktreePath, AI_DIR), AI_DIR, false, unplaced)
  }
  if (unplaced.length === 0) await removeKeptRoot(keptRoot)
  return unplaced
}

async function removeKeptRoot(keptRoot: string): Promise<void> {
  await fsp.rm(keptRoot, { recursive: true, force: true })
  const parent = path.dirname(keptRoot)
  // Best effort: the work is done once the kept root is gone.
  if (path.basename(parent) === KEPT_DIR_NAME) await rmdirIfEmpty(parent).catch(() => {})
}

/** Puts `keptRoot` back into `worktreePath`. Never throws: returns one operator warning, or null when everything was placed. */
export async function putBackKeptRoot(keptRoot: string, worktreePath: string): Promise<string | null> {
  try {
    const unplaced = await putBackAiFolder(keptRoot, worktreePath)
    if (unplaced.length === 0) return null
    return `Some kept files could not be put back because the worktree already has a different entry at the same path: ${unplaced.join(', ')}. They are still in '${keptRoot}'; compare and move them by hand.`
  } catch (err) {
    return `Could not put the .ai folder back from '${keptRoot}': ${errorMessage(err)}. Move its content into '${path.join(worktreePath, AI_DIR)}' by hand.`
  }
}

/** Put-back for a recorded workspace. Never throws: returns warnings (empty when nothing was kept or all went well). */
export async function putBackKeptAiFor(workspace: KeptAiRecord): Promise<string[]> {
  const keptRoot = existingKeptRoot(workspace)
  if (!keptRoot) return []
  const warning = await putBackKeptRoot(keptRoot, workspace.worktreePath)
  return warning ? [warning] : []
}

/** Removes the recorded kept root. Never throws: returns warnings. */
export async function removeKeptAiFor(workspace: KeptAiRemoval): Promise<string[]> {
  let keptRoot = existingKeptRoot(workspace)
  if (!keptRoot && !workspace.worktreePurgedAt) keptRoot = computedKeptRootIfExists(workspace)
  if (!keptRoot) return []
  try {
    await removeKeptRoot(keptRoot)
    return []
  } catch (err) {
    return [`Could not remove the kept .ai folder '${keptRoot}': ${errorMessage(err)}. Remove it by hand.`]
  }
}
