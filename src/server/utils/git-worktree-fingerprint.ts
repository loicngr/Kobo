import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'

/** Hash diffs and untracked contents without loading large files into memory. */
export async function fingerprintWorktree(cwd: string): Promise<string> {
  return fingerprintRepository(await realpath(cwd), new Set())
}

/** Nested repositories contribute HEAD and their own Git-filtered working state, never a .git traversal. */
async function fingerprintRepository(cwd: string, visited: Set<string>): Promise<string> {
  if (visited.has(cwd)) throw new Error('Cannot fingerprint a recursive repository path')
  visited.add(cwd)
  const gitOptions = { cwd, encoding: 'utf8' as const, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }
  const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], gitOptions).trim()
  if ((await realpath(topLevel)) !== cwd) throw new Error('Working tree changed during fingerprinting; retry diagnosis')

  const hash = createHash('sha256')
  let head: string
  try {
    head = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], gitOptions).trim()
  } catch (err) {
    // A freshly initialized nested repository has no commit yet. Other Git failures remain fatal.
    if ((err as { status?: number }).status !== 1) throw err
    head = 'unborn'
  }
  hash.update(`HEAD\0${head}\0`)
  for (const staged of [false, true]) {
    hash.update(staged ? 'index\0' : 'working-tree\0')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'git',
        ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', ...(staged ? ['--cached'] : []), '--'],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
      )
      child.stdout.on('data', (chunk: Buffer) => hash.update(chunk))
      child.stderr.resume()
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Cannot fingerprint working tree diff'))))
    })
  }
  const names = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .sort()
  for (const name of names) {
    hash.update(`\0untracked\0${name}\0`)
    // Remove Git's trailing slash for nested repos before lstat, so a link is never dereferenced.
    const filePath = path.resolve(cwd, name)
    const stat = await lstat(filePath)
    hash.update(`${stat.mode}\0`)
    if (stat.isSymbolicLink()) {
      hash.update(await readlink(filePath))
    } else if (stat.isFile()) {
      const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await file.stat()
        for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
        const after = await file.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
          throw new Error('Working tree changed during fingerprinting; retry diagnosis')
      } finally {
        await file.close()
      }
    } else if (stat.isDirectory()) {
      // `ls-files --others` reports an embedded repository as a directory instead of its files.
      const nestedPath = await realpath(filePath)
      const relative = path.relative(cwd, nestedPath)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('Nested repository escapes the working tree')
      hash.update(`\0repository\0${await fingerprintRepository(nestedPath, visited)}\0`)
    } else {
      throw new Error('Cannot fingerprint a non-regular untracked file')
    }
  }
  return hash.digest('hex')
}
