const STORAGE_KEY = 'kobo:create-page-prefs'

export interface CreatePagePrefs {
  projectPath?: string
  autoLoop?: boolean
}

function readRaw(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function loadCreatePagePrefs(): CreatePagePrefs {
  const raw = readRaw()
  if (!isPlainObject(raw)) return {}
  const out: CreatePagePrefs = {}
  if (typeof raw.projectPath === 'string' && raw.projectPath.length > 0) {
    out.projectPath = raw.projectPath
  }
  if (typeof raw.autoLoop === 'boolean') {
    out.autoLoop = raw.autoLoop
  }
  return out
}

export function saveCreatePagePrefs(prefs: CreatePagePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Storage unavailable, quota exceeded, etc. — silent by contract.
  }
}
