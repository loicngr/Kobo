import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ worktreesPath: '' }))
const excludeFromProjectGit = vi.hoisted(() => vi.fn())
const logWarn = vi.hoisted(() => vi.fn())

vi.mock('../server/services/settings-service.js', () => ({
  getGlobalSettings: () => ({ worktreesPath: state.worktreesPath }),
}))
vi.mock('../server/services/worktree-service.js', () => ({ excludeFromProjectGit }))
vi.mock('../server/utils/logger.js', () => ({
  logWarn,
  logError: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}))

import {
  computedKeptRootIfExists,
  computeKeptRoot,
  existingKeptRoot,
  keepAiFolder,
  putBackAiFolder,
  putBackKeptAiFor,
  putBackKeptRoot,
  removeKeptAiFor,
  workspaceFilesRoot,
} from '../server/services/kept-ai-service.js'

let tmp: string
let project: string
let worktree: string
let keptRoot: string
let keptParent: string
const ws = () => ({ id: 'ws1', projectPath: project, worktreePath: worktree, workingBranch: 'feature/x' })

async function write(file: string, content: string, mtime?: Date): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  if (mtime) await fs.utimes(file, mtime, mtime)
}
const read = (file: string) => fs.readFile(file, 'utf8')
const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  )

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kobo-kept-ai-'))
  project = path.join(tmp, 'project')
  state.worktreesPath = path.join(tmp, 'wt')
  worktree = path.join(state.worktreesPath, 'slug', 'feature', 'x')
  keptParent = path.join(state.worktreesPath, '.kobo-kept')
  keptRoot = path.join(keptParent, 'ws1')
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(worktree, { recursive: true })
  excludeFromProjectGit.mockReset()
  excludeFromProjectGit.mockResolvedValue(undefined)
  logWarn.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('computeKeptRoot', () => {
  it('is <base>/.kobo-kept/<id>', () => {
    expect(computeKeptRoot(ws())).toBe(keptRoot)
  })
})

describe('keepAiFolder', () => {
  it('moves .ai to the kept root, keeps modification times and leaves no .ai behind', async () => {
    const when = new Date('2024-01-02T03:04:05Z')
    await write(path.join(worktree, '.ai/thoughts/a.md'), 'A', when)
    await write(path.join(worktree, '.ai/images/i.png'), 'I', when)
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(await read(path.join(keptRoot, '.ai/thoughts/a.md'))).toBe('A')
    expect(await read(path.join(keptRoot, '.ai/images/i.png'))).toBe('I')
    expect((await fs.stat(path.join(keptRoot, '.ai/thoughts/a.md'))).mtime.getTime()).toBe(when.getTime())
    expect(await exists(path.join(worktree, '.ai'))).toBe(false)
  })

  it('deletes .script-* folders instead of keeping them', async () => {
    await write(path.join(worktree, '.ai/.script-abc123/run.sh'), 'x')
    await write(path.join(worktree, '.ai/notes.md'), 'n')
    await keepAiFolder(ws())
    expect(await exists(path.join(keptRoot, '.ai/.script-abc123'))).toBe(false)
    expect(await exists(path.join(worktree, '.ai/.script-abc123'))).toBe(false)
    expect(await read(path.join(keptRoot, '.ai/notes.md'))).toBe('n')
  })

  it('returns null and creates nothing when there is no .ai', async () => {
    expect(await keepAiFolder(ws())).toBeNull()
    expect(await exists(keptParent)).toBe(false)
  })

  it('returns the existing kept root when there is no .ai but a kept root is already there', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(await read(path.join(keptRoot, '.ai/a.md'))).toBe('A')
  })

  it('does not keep nor follow a symbolic link named .ai', async () => {
    const target = path.join(tmp, 'elsewhere')
    await write(path.join(target, 'secret.md'), 's')
    await fs.symlink(target, path.join(worktree, '.ai'))
    expect(await keepAiFolder(ws())).toBeNull()
    expect((await fs.lstat(path.join(worktree, '.ai'))).isSymbolicLink()).toBe(true)
    expect(await read(path.join(target, 'secret.md'))).toBe('s')
    expect(await exists(keptRoot)).toBe(false)

    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await keepAiFolder(ws())).toBe(keptRoot)
  })

  it('merges into an existing kept root: live wins, kept-only files survive', async () => {
    await write(path.join(keptRoot, '.ai/same.md'), 'old')
    await write(path.join(keptRoot, '.ai/kept-only.md'), 'K')
    await write(path.join(worktree, '.ai/same.md'), 'live')
    await write(path.join(worktree, '.ai/new/n.md'), 'N')
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(await read(path.join(keptRoot, '.ai/same.md'))).toBe('live')
    expect(await read(path.join(keptRoot, '.ai/kept-only.md'))).toBe('K')
    expect(await read(path.join(keptRoot, '.ai/new/n.md'))).toBe('N')
    expect(await exists(path.join(worktree, '.ai'))).toBe(false)
  })

  it('rejects when the kept root path is a regular file and leaves .ai complete', async () => {
    await write(path.join(worktree, '.ai/thoughts/a.md'), 'A')
    await write(path.join(worktree, '.ai/.script-x/s.sh'), 'S')
    await write(keptRoot, 'in the way')
    await expect(keepAiFolder(ws())).rejects.toThrow(/not a folder/)
    expect(await read(path.join(worktree, '.ai/thoughts/a.md'))).toBe('A')
    expect(await read(path.join(worktree, '.ai/.script-x/s.sh'))).toBe('S')
    expect(await read(keptRoot)).toBe('in the way')
  })

  it('rejects when .kobo-kept is a regular file and leaves .ai complete', async () => {
    await write(path.join(worktree, '.ai/a.md'), 'A')
    await write(keptParent, 'in the way')
    await expect(keepAiFolder(ws())).rejects.toThrow()
    expect(await read(path.join(worktree, '.ai/a.md'))).toBe('A')
  })

  it('copies then removes when the rename crosses devices (EXDEV), keeping timestamps', async () => {
    const when = new Date('2023-05-06T07:08:09Z')
    await write(path.join(worktree, '.ai/thoughts/a.md'), 'A', when)
    const realRename = fs.rename.bind(fs)
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(worktree, '.ai')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(from, to)
    })
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(rename).toHaveBeenCalled()
    expect(await read(path.join(keptRoot, '.ai/thoughts/a.md'))).toBe('A')
    expect((await fs.stat(path.join(keptRoot, '.ai/thoughts/a.md'))).mtime.getTime()).toBe(when.getTime())
    expect(await exists(path.join(worktree, '.ai'))).toBe(false)
  })

  it('leaves .ai complete and no partial copy when the EXDEV copy fails', async () => {
    await write(path.join(worktree, '.ai/thoughts/a.md'), 'A')
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    vi.spyOn(fs, 'cp').mockImplementation(async (_from, to) => {
      await fs.mkdir(String(to), { recursive: true })
      throw new Error('disk full')
    })
    await expect(keepAiFolder(ws())).rejects.toThrow('disk full')
    expect(await read(path.join(worktree, '.ai/thoughts/a.md'))).toBe('A')
    expect(await exists(path.join(keptRoot, '.ai'))).toBe(false)
    expect(await exists(keptRoot)).toBe(false)
  })

  it('excludes the .kobo-kept folder from the project git; a rejection does not fail the keep', async () => {
    await write(path.join(worktree, '.ai/a.md'), 'A')
    excludeFromProjectGit.mockRejectedValue(new Error('not a git repository'))
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(excludeFromProjectGit).toHaveBeenCalledTimes(1)
    expect(excludeFromProjectGit).toHaveBeenCalledWith(project, keptParent)
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('putBackAiFolder', () => {
  it('moves .ai back into a worktree without one and removes the kept root and its parent', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await read(path.join(worktree, '.ai/a.md'))).toBe('A')
    expect(await exists(keptRoot)).toBe(false)
    expect(await exists(keptParent)).toBe(false)
  })

  it('keeps the .kobo-kept folder when another workspace still has a kept root', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    await write(path.join(keptParent, 'ws2/.ai/b.md'), 'B')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await exists(path.join(keptParent, 'ws2/.ai/b.md'))).toBe(true)
  })

  it('never overwrites: an existing identical file wins and the kept copy is dropped', async () => {
    await write(path.join(worktree, '.ai/.gitignore'), 'live')
    await write(path.join(keptRoot, '.ai/.gitignore'), 'live')
    await write(path.join(keptRoot, '.ai/thoughts/a.md'), 'A')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await read(path.join(worktree, '.ai/.gitignore'))).toBe('live')
    expect(await read(path.join(worktree, '.ai/thoughts/a.md'))).toBe('A')
    expect(await exists(keptRoot)).toBe(false)
  })

  it('reports type conflicts and leaves only those entries in the kept root', async () => {
    await write(path.join(worktree, '.ai/dir-vs-file'), 'a file')
    await fs.mkdir(path.join(worktree, '.ai/file-vs-dir'), { recursive: true })
    await write(path.join(keptRoot, '.ai/dir-vs-file/x.md'), 'X')
    await write(path.join(keptRoot, '.ai/file-vs-dir'), 'a kept file')
    await write(path.join(keptRoot, '.ai/ok.md'), 'OK')
    const unplaced = await putBackAiFolder(keptRoot, worktree)
    expect([...unplaced].sort()).toEqual(['.ai/dir-vs-file', '.ai/file-vs-dir'].sort())
    expect(await read(path.join(worktree, '.ai/ok.md'))).toBe('OK')
    expect(await read(path.join(worktree, '.ai/dir-vs-file'))).toBe('a file')
    expect(await read(path.join(keptRoot, '.ai/dir-vs-file/x.md'))).toBe('X')
    expect(await read(path.join(keptRoot, '.ai/file-vs-dir'))).toBe('a kept file')
    expect(await exists(path.join(keptRoot, '.ai/ok.md'))).toBe(false)
  })

  it('reports a symbolic link on either side as a conflict', async () => {
    await write(path.join(tmp, 'target.md'), 't')
    await write(path.join(worktree, '.ai/a.md'), 'live')
    await fs.mkdir(path.join(keptRoot, '.ai'), { recursive: true })
    await fs.symlink(path.join(tmp, 'target.md'), path.join(keptRoot, '.ai/a.md'))
    const unplaced = await putBackAiFolder(keptRoot, worktree)
    expect(unplaced).toEqual(['.ai/a.md'])
    expect(await read(path.join(worktree, '.ai/a.md'))).toBe('live')
    expect((await fs.lstat(path.join(keptRoot, '.ai/a.md'))).isSymbolicLink()).toBe(true)
  })

  it('resolves with [] on a second call after success', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await read(path.join(worktree, '.ai/a.md'))).toBe('A')
  })
})

describe('existingKeptRoot / workspaceFilesRoot', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    id: 'ws1',
    worktreePath: worktree,
    worktreePurgedAt: '2026-01-01T00:00:00.000Z',
    worktreePurgeRestoreData: JSON.stringify({ keptAiPath: keptRoot }),
    ...over,
  })

  it('uses the worktree when the workspace is not purged', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(existingKeptRoot(record({ worktreePurgedAt: null }))).toBeNull()
    expect(workspaceFilesRoot(record({ worktreePurgedAt: null }))).toBe(worktree)
  })

  it('uses the recorded kept root while purged and present on disk', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(existingKeptRoot(record())).toBe(keptRoot)
    expect(workspaceFilesRoot(record())).toBe(keptRoot)
  })

  it('ignores a recorded path of another workspace or one that no longer exists', async () => {
    await write(path.join(keptParent, 'ws2/.ai/a.md'), 'A')
    const other = record({ worktreePurgeRestoreData: JSON.stringify({ keptAiPath: path.join(keptParent, 'ws2') }) })
    expect(workspaceFilesRoot(other)).toBe(worktree)
    expect(workspaceFilesRoot(record())).toBe(worktree)
    expect(existingKeptRoot(record({ worktreePurgeRestoreData: null }))).toBeNull()
  })

  it('does not treat a symbolic link or a file as a kept root', async () => {
    await fs.mkdir(keptParent, { recursive: true })
    await fs.mkdir(path.join(tmp, 'real'))
    await fs.symlink(path.join(tmp, 'real'), keptRoot)
    expect(existingKeptRoot(record())).toBeNull()
    await fs.rm(keptRoot)
    await write(keptRoot, 'file')
    expect(existingKeptRoot(record())).toBeNull()
  })

  it('uses the recorded path, not a recomputed one, when the setting changed', async () => {
    const moved = path.join(tmp, 'old-base', '.kobo-kept', 'ws1')
    await write(path.join(moved, '.ai/a.md'), 'A')
    const rec = record({ worktreePurgeRestoreData: JSON.stringify({ keptAiPath: moved }) })
    expect(workspaceFilesRoot(rec)).toBe(moved)
  })
})

describe('putBackKeptAiFor', () => {
  const record = (data: unknown = { keptAiPath: keptRoot }) => ({
    id: 'ws1',
    worktreePath: worktree,
    worktreePurgedAt: '2026-01-01T00:00:00.000Z',
    worktreePurgeRestoreData: data === null ? null : JSON.stringify(data),
  })

  it('returns [] when nothing is recorded or the kept folder is gone', async () => {
    expect(await putBackKeptAiFor(record(null))).toEqual([])
    expect(await putBackKeptAiFor(record({ prNumber: 1 }))).toEqual([])
    expect(await putBackKeptAiFor(record())).toEqual([])
  })

  it('puts the folder back and returns no warning', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await putBackKeptAiFor(record())).toEqual([])
    expect(await read(path.join(worktree, '.ai/a.md'))).toBe('A')
  })

  it('returns one warning naming the kept root on failure', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    await fs.rm(worktree, { recursive: true })
    const warnings = await putBackKeptAiFor(record())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`Could not put the .ai folder back from '${keptRoot}'`)
    expect(warnings[0]).toContain(`Move its content into '${path.join(worktree, '.ai')}' by hand.`)
  })

  it('returns one warning naming the unplaced paths and the kept root', async () => {
    await write(path.join(worktree, '.ai/clash'), 'file')
    await write(path.join(keptRoot, '.ai/clash/x.md'), 'X')
    const warnings = await putBackKeptAiFor(record())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('.ai/clash')
    expect(warnings[0]).toContain('already has a different entry at the same path')
    expect(warnings[0]).toContain(`They are still in '${keptRoot}'; compare and move them by hand.`)
  })
})

describe('removeKeptAiFor', () => {
  const record = (data: unknown = { keptAiPath: keptRoot }) => ({
    id: 'ws1',
    projectPath: project,
    workingBranch: 'feature/x',
    worktreePath: worktree,
    worktreePurgedAt: '2026-01-01T00:00:00.000Z',
    worktreePurgeRestoreData: data === null ? null : JSON.stringify(data),
  })

  it('removes the kept root and the empty .kobo-kept folder', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await removeKeptAiFor(record())).toEqual([])
    expect(await exists(keptRoot)).toBe(false)
    expect(await exists(keptParent)).toBe(false)
  })

  it('keeps .kobo-kept while another workspace is stored in it', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    await write(path.join(keptParent, 'ws2/.ai/b.md'), 'B')
    expect(await removeKeptAiFor(record())).toEqual([])
    expect(await exists(path.join(keptParent, 'ws2/.ai/b.md'))).toBe(true)
  })

  it('returns [] when nothing is recorded or it is already gone', async () => {
    expect(await removeKeptAiFor(record(null))).toEqual([])
    expect(await removeKeptAiFor(record())).toEqual([])
  })

  it('returns one warning naming the path on failure', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    vi.spyOn(fs, 'rm').mockRejectedValue(new Error('EACCES: denied'))
    const warnings = await removeKeptAiFor(record())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`Could not remove the kept .ai folder '${keptRoot}'`)
    expect(warnings[0]).toContain('Remove it by hand.')
    expect(fsSync.existsSync(keptRoot)).toBe(true)
  })
})

describe('fix round 1', () => {
  const record = () => ({
    id: 'ws1',
    projectPath: project,
    workingBranch: 'feature/x',
    worktreePath: worktree,
    worktreePurgedAt: '2026-01-01T00:00:00.000Z',
    worktreePurgeRestoreData: JSON.stringify({ keptAiPath: keptRoot }),
  })

  it('I1: a failing .kobo-kept parent cleanup is not reported as a failure', async () => {
    const realRmdir = fs.rmdir.bind(fs)
    vi.spyOn(fs, 'rmdir').mockImplementation(async (p, ...rest) => {
      if (String(p) === keptParent) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return realRmdir(p, ...rest)
    })
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await exists(keptRoot)).toBe(false)
    await write(path.join(keptRoot, '.ai/b.md'), 'B')
    expect(await removeKeptAiFor(record())).toEqual([])
    expect(await exists(keptRoot)).toBe(false)
    await write(path.join(keptRoot, '.ai/c.md'), 'C')
    expect(await putBackKeptAiFor(record())).toEqual([])
  })

  it('I2: keep survives .kobo-kept being removed while the exclude call runs', async () => {
    await write(path.join(worktree, '.ai/a.md'), 'A')
    excludeFromProjectGit.mockImplementation(async () => {
      await fs.rm(keptParent, { recursive: true, force: true })
    })
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(await read(path.join(keptRoot, '.ai/a.md'))).toBe('A')
  })

  it('M1: computeKeptRoot and keepAiFolder refuse a non-absolute kept root', async () => {
    const relative = { ...ws(), worktreePath: 'some/where' }
    expect(() => computeKeptRoot(relative)).toThrow("Cannot resolve a kept folder for worktree 'some/where'")
    await expect(keepAiFolder(relative)).rejects.toThrow(/Cannot resolve a kept folder/)
  })

  it('M3: a live file against a kept directory keeps the kept directory beside it', async () => {
    await write(path.join(keptRoot, '.ai/clash/old.md'), 'old')
    await write(path.join(worktree, '.ai/clash'), 'live file')
    await keepAiFolder(ws())
    expect(await read(path.join(keptRoot, '.ai/clash'))).toBe('live file')
    const aside = (await fs.readdir(path.join(keptRoot, '.ai'))).filter((n) => n.startsWith('clash.kept-'))
    expect(aside).toHaveLength(1)
    expect(await read(path.join(keptRoot, '.ai', aside[0], 'old.md'))).toBe('old')
  })

  it('M3: a live directory against a kept file keeps the kept file beside it', async () => {
    await write(path.join(keptRoot, '.ai/clash'), 'old file')
    await write(path.join(worktree, '.ai/clash/new.md'), 'new')
    await keepAiFolder(ws())
    expect(await read(path.join(keptRoot, '.ai/clash/new.md'))).toBe('new')
    const aside = (await fs.readdir(path.join(keptRoot, '.ai'))).filter((n) => n.startsWith('clash.kept-'))
    expect(aside).toHaveLength(1)
    expect(await read(path.join(keptRoot, '.ai', aside[0]))).toBe('old file')
  })

  it('M4: symbolic links inside .ai travel as links, targets untouched', async () => {
    const outside = path.join(tmp, 'outside.txt')
    await write(outside, 'outside')
    await write(path.join(worktree, '.ai/real.md'), 'R')
    await fs.mkdir(path.join(worktree, '.ai/dir'))
    const links: Record<string, string> = {
      'to-file': 'real.md',
      'to-dir': 'dir',
      'to-outside': outside,
      dangling: 'missing-target',
    }
    for (const [name, target] of Object.entries(links)) await fs.symlink(target, path.join(worktree, '.ai', name))
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    for (const [name, target] of Object.entries(links)) {
      expect(await fs.readlink(path.join(keptRoot, '.ai', name))).toBe(target)
    }
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    for (const [name, target] of Object.entries(links)) {
      expect((await fs.lstat(path.join(worktree, '.ai', name))).isSymbolicLink()).toBe(true)
      expect(await fs.readlink(path.join(worktree, '.ai', name))).toBe(target)
    }
    expect(await read(outside)).toBe('outside')
  })

  it('M4: EXDEV copy succeeds but removing the source fails -> keep rejects, a second keep completes', async () => {
    await write(path.join(worktree, '.ai/thoughts/a.md'), 'A')
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(worktree, '.ai')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(from, to)
    })
    const realRm = fs.rm.bind(fs)
    let failRm = true
    vi.spyOn(fs, 'rm').mockImplementation(async (p, opts) => {
      if (failRm && String(p) === path.join(worktree, '.ai')) throw new Error('busy')
      return realRm(p, opts)
    })
    await expect(keepAiFolder(ws())).rejects.toThrow('busy')
    expect(await read(path.join(keptRoot, '.ai/thoughts/a.md'))).toBe('A')
    failRm = false
    expect(await keepAiFolder(ws())).toBe(keptRoot)
    expect(await read(path.join(keptRoot, '.ai/thoughts/a.md'))).toBe('A')
    expect(await exists(path.join(worktree, '.ai'))).toBe(false)
  })

  it('M4: putBackAiFolder copies then removes across devices', async () => {
    const when = new Date('2022-02-03T04:05:06Z')
    await write(path.join(keptRoot, '.ai/thoughts/a.md'), 'A', when)
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(keptRoot, '.ai')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return realRename(from, to)
    })
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect((await fs.stat(path.join(worktree, '.ai/thoughts/a.md'))).mtime.getTime()).toBe(when.getTime())
    expect(await exists(keptRoot)).toBe(false)
  })
})

describe('fix round 2', () => {
  const big = (n: number, tail: string) => Buffer.concat([Buffer.alloc(n, 'x'), Buffer.from(tail)])
  const names = async (dir: string) => (await fs.readdir(dir)).sort()

  it('F2: keep with identical content drops the source copy', async () => {
    await write(path.join(keptRoot, '.ai/n.md'), 'same')
    await write(path.join(worktree, '.ai/n.md'), 'same')
    await keepAiFolder(ws())
    expect(await names(path.join(keptRoot, '.ai'))).toEqual(['n.md'])
    expect(await exists(path.join(worktree, '.ai'))).toBe(false)
  })

  it('F2: keep with different content keeps the older kept file aside', async () => {
    await write(path.join(keptRoot, '.ai/n.md'), 'older')
    await write(path.join(worktree, '.ai/n.md'), 'newer')
    await keepAiFolder(ws())
    expect(await read(path.join(keptRoot, '.ai/n.md'))).toBe('newer')
    const aside = (await names(path.join(keptRoot, '.ai'))).filter((n) => n.startsWith('n.md.kept-'))
    expect(aside).toHaveLength(1)
    expect(await read(path.join(keptRoot, '.ai', aside[0]))).toBe('older')
  })

  it('F2: put-back with identical content drops the kept copy and removes the kept root', async () => {
    await write(path.join(worktree, '.ai/n.md'), 'same')
    await write(path.join(keptRoot, '.ai/n.md'), 'same')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await read(path.join(worktree, '.ai/n.md'))).toBe('same')
    expect(await exists(keptRoot)).toBe(false)
  })

  it('F2: put-back with different content leaves the kept file and reports it', async () => {
    await write(path.join(worktree, '.ai/n.md'), 'checked out')
    await write(path.join(keptRoot, '.ai/n.md'), 'my uncommitted edit')
    await write(path.join(keptRoot, '.ai/other.md'), 'O')
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual(['.ai/n.md'])
    expect(await read(path.join(worktree, '.ai/n.md'))).toBe('checked out')
    expect(await read(path.join(keptRoot, '.ai/n.md'))).toBe('my uncommitted edit')
    expect(await read(path.join(worktree, '.ai/other.md'))).toBe('O')
    const warnings = await putBackKeptAiFor({
      id: 'ws1',
      worktreePath: worktree,
      worktreePurgedAt: '2026-01-01T00:00:00.000Z',
      worktreePurgeRestoreData: JSON.stringify({ keptAiPath: keptRoot }),
    })
    expect(warnings[0]).toContain('.ai/n.md')
  })

  it('F2: compares multi-MiB files by content', async () => {
    const size = 5 * 1024 * 1024
    await fs.mkdir(path.join(worktree, '.ai'), { recursive: true })
    await fs.mkdir(path.join(keptRoot, '.ai'), { recursive: true })
    await fs.writeFile(path.join(worktree, '.ai/same.bin'), big(size, 'a'))
    await fs.writeFile(path.join(keptRoot, '.ai/same.bin'), big(size, 'a'))
    await fs.writeFile(path.join(worktree, '.ai/diff.bin'), big(size, 'a'))
    await fs.writeFile(path.join(keptRoot, '.ai/diff.bin'), big(size, 'b'))
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual(['.ai/diff.bin'])
    expect(await exists(path.join(keptRoot, '.ai/same.bin'))).toBe(false)
    expect((await fs.readFile(path.join(keptRoot, '.ai/diff.bin'))).subarray(-1).toString()).toBe('b')
  })

  it('F3: two aside renames of the same name with a frozen clock give distinct files', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    await write(path.join(keptRoot, '.ai/n.md'), 'v1')
    await write(path.join(worktree, '.ai/n.md'), 'v2')
    await keepAiFolder(ws())
    await write(path.join(worktree, '.ai/n.md'), 'v3')
    await keepAiFolder(ws())
    const all = await names(path.join(keptRoot, '.ai'))
    expect(all.filter((n) => n.startsWith('n.md.kept-'))).toHaveLength(2)
    const contents = await Promise.all(all.map((n) => read(path.join(keptRoot, '.ai', n))))
    expect(contents.sort()).toEqual(['v1', 'v2', 'v3'])
  })

  const rec = (over: Record<string, unknown> = {}) => ({
    id: 'ws1',
    projectPath: project,
    workingBranch: 'feature/x',
    worktreePath: worktree,
    worktreePurgedAt: null as string | null,
    worktreePurgeRestoreData: null as string | null,
    ...over,
  })

  it('F4: a non-purged workspace with a leftover computed root has it removed', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await removeKeptAiFor(rec())).toEqual([])
    expect(await exists(keptRoot)).toBe(false)
    expect(await exists(keptParent)).toBe(false)
  })

  it('F4: a non-purged workspace without a leftover has nothing to remove', async () => {
    expect(await removeKeptAiFor(rec())).toEqual([])
  })

  it('F4: a purged workspace removes only the recorded root', async () => {
    const recorded = path.join(tmp, 'old-base', '.kobo-kept', 'ws1')
    await write(path.join(recorded, '.ai/a.md'), 'A')
    await write(path.join(keptRoot, '.ai/b.md'), 'B')
    const purged = rec({
      worktreePurgedAt: '2026-01-01T00:00:00.000Z',
      worktreePurgeRestoreData: JSON.stringify({ keptAiPath: recorded }),
    })
    expect(await removeKeptAiFor(purged)).toEqual([])
    expect(await exists(recorded)).toBe(false)
    expect(await read(path.join(keptRoot, '.ai/b.md'))).toBe('B')
  })

  it('F4: a computeKeptRoot failure means nothing to remove', async () => {
    expect(await removeKeptAiFor(rec({ worktreePath: 'relative/place' }))).toEqual([])
  })
})

describe('sameContent strictness (through put-back)', () => {
  type Handle = Awaited<ReturnType<typeof fs.open>>
  const limited = (real: Handle, perRead: number, eofAt = Number.POSITIVE_INFINITY) =>
    ({
      read: (buf: Buffer, off: number, len: number, pos: number) =>
        pos >= eofAt
          ? Promise.resolve({ bytesRead: 0, buffer: buf })
          : real.read(buf, off, Math.min(len, perRead, eofAt - pos), pos),
      close: () => real.close(),
    }) as unknown as Handle
  const spyOpen = (wrap: (real: Handle, call: number) => Handle) => {
    const realOpen = fs.open.bind(fs)
    let call = 0
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const real = await realOpen(...args)
      return wrap(real, call++)
    }) as typeof fs.open)
  }
  const pair = async (kept: Buffer, live: Buffer) => {
    await fs.mkdir(path.join(keptRoot, '.ai'), { recursive: true })
    await fs.mkdir(path.join(worktree, '.ai'), { recursive: true })
    await fs.writeFile(path.join(keptRoot, '.ai/f.bin'), kept)
    await fs.writeFile(path.join(worktree, '.ai/f.bin'), live)
  }

  it('detects a difference after the first short read', async () => {
    const a = Buffer.alloc(5000, 'x')
    const b = Buffer.from(a)
    b[3000] = 0x79
    await pair(a, b)
    spyOpen((real) => limited(real, 1000))
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual(['.ai/f.bin'])
    expect((await fs.readFile(path.join(keptRoot, '.ai/f.bin')))[3000]).toBe(0x78)
  })

  it('still reports identical files as identical with short reads', async () => {
    await pair(Buffer.alloc(5000, 'x'), Buffer.alloc(5000, 'x'))
    spyOpen((real) => limited(real, 1000))
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual([])
    expect(await exists(keptRoot)).toBe(false)
  })

  it('closes the first handle and rejects when the second open fails', async () => {
    await pair(Buffer.alloc(100, 'x'), Buffer.alloc(100, 'x'))
    const realOpen = fs.open.bind(fs)
    let first: Handle | undefined
    let closed = false
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (first) throw new Error('EMFILE')
      first = await realOpen(...args)
      const realClose = first.close.bind(first)
      first.close = async () => {
        closed = true
        return realClose()
      }
      return first
    }) as typeof fs.open)
    await expect(putBackAiFolder(keptRoot, worktree)).rejects.toThrow('EMFILE')
    expect(closed).toBe(true)
    expect(await exists(path.join(keptRoot, '.ai/f.bin'))).toBe(true)
  })

  it('treats a file truncated after the size check as different', async () => {
    await pair(Buffer.alloc(5000, 'x'), Buffer.alloc(5000, 'x'))
    spyOpen((real, call) => (call === 1 ? limited(real, 64 * 1024, 2000) : real))
    expect(await putBackAiFolder(keptRoot, worktree)).toEqual(['.ai/f.bin'])
    expect(await exists(path.join(keptRoot, '.ai/f.bin'))).toBe(true)
  })
})

describe('review fix wave helpers', () => {
  it('computedKeptRootIfExists: real directory -> root, missing -> null, symlink -> null', async () => {
    expect(computedKeptRootIfExists(ws())).toBeNull()
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(computedKeptRootIfExists(ws())).toBe(keptRoot)
    await fs.rm(keptRoot, { recursive: true })
    await fs.mkdir(path.join(tmp, 'real'))
    await fs.symlink(path.join(tmp, 'real'), keptRoot)
    expect(computedKeptRootIfExists(ws())).toBeNull()
  })

  it('computedKeptRootIfExists never throws: a failure to compute is logged and gives null', () => {
    expect(computedKeptRootIfExists({ ...ws(), worktreePath: 'relative/place' })).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })

  it('putBackKeptRoot: null on success, one warning on rejection, one on unplaced entries', async () => {
    await write(path.join(keptRoot, '.ai/a.md'), 'A')
    expect(await putBackKeptRoot(keptRoot, worktree)).toBeNull()
    expect(await read(path.join(worktree, '.ai/a.md'))).toBe('A')

    await write(path.join(worktree, '.ai/clash'), 'file')
    await write(path.join(keptRoot, '.ai/clash/x.md'), 'X')
    const unplaced = await putBackKeptRoot(keptRoot, worktree)
    expect(unplaced).toContain('already has a different entry at the same path: .ai/clash')
    expect(unplaced).toContain(`They are still in '${keptRoot}'; compare and move them by hand.`)

    await fs.rm(worktree, { recursive: true })
    const failed = await putBackKeptRoot(keptRoot, worktree)
    expect(failed).toContain(`Could not put the .ai folder back from '${keptRoot}'`)
  })
})
