import path from 'node:path'

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

function slugifyOne(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Produce a cross-OS-safe directory name (Linux + macOS + Windows) from a
 * project's display name, falling back to the path basename and finally to
 * the literal `'project'`. Output is guaranteed to be non-empty and to avoid
 * Windows reserved names (CON, PRN, COM1..9, LPT1..9, AUX, NUL).
 */
export function slugifyProjectName(displayName: string, projectPath: string): string {
  const fromDisplay = slugifyOne((displayName ?? '').trim())
  if (fromDisplay) return guard(fromDisplay)

  const basename = path.basename(projectPath ?? '')
  const fromBasename = slugifyOne(basename)
  if (fromBasename) return guard(fromBasename)

  return 'project'
}

function guard(slug: string): string {
  return WINDOWS_RESERVED.has(slug) ? `${slug}-project` : slug
}
