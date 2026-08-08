import fs from 'node:fs'
import path from 'node:path'

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Resolve two existing paths and reject candidates that escape through a symlinked parent. */
export function resolveExistingPathInside(rootPath: string, candidatePath: string): string {
  const realRoot = fs.realpathSync(rootPath)
  const realCandidate = fs.realpathSync(candidatePath)
  if (!isPathInside(realRoot, realCandidate)) throw new Error('Path escapes allowed root')
  return realCandidate
}
