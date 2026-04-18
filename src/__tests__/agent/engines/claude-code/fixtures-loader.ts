import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, '../../../fixtures/claude-streams')

/** Read one `.ndjson` fixture and return its non-empty lines (may include raw non-JSON). */
export function loadFixture(name: string): string[] {
  const file = resolve(fixturesDir, `${name}.ndjson`)
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
}
