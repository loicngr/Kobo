import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Replace a JSON file only after a complete write in the same filesystem. */
export function writeJsonFileAtomically(filePath: string, value: unknown): void {
  const contents = JSON.stringify(value, null, 2)
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporaryPath, filePath)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[atomic-json-file] Failed to remove temporary file:', error)
      }
    }
  }
}
