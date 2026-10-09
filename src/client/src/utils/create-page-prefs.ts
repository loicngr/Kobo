import type { AutoLoopReviewConfiguration } from '../../../shared/auto-loop-review'

const STORAGE_KEY = 'kobo:create-page-prefs'

export interface CreatePagePrefs {
  projectPath?: string
  autoLoop?: boolean
  autoLoopSessionMode?: 'per_task' | 'continuous'
  autoLoopFinalReview?: AutoLoopReviewConfiguration | null
  brainstormModel?: string
  reasoningEffortByModel?: Record<string, string>
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
  if (raw.autoLoopSessionMode === 'per_task' || raw.autoLoopSessionMode === 'continuous') {
    out.autoLoopSessionMode = raw.autoLoopSessionMode
  }
  if (typeof raw.brainstormModel === 'string' && raw.brainstormModel.length > 0) {
    out.brainstormModel = raw.brainstormModel
  }
  const review = raw.autoLoopFinalReview
  if (review === null) out.autoLoopFinalReview = null
  else if (
    isPlainObject(review) &&
    (review.engine === 'claude-code' || review.engine === 'codex') &&
    typeof review.model === 'string' &&
    review.model.trim() &&
    typeof review.reasoningEffort === 'string' &&
    review.reasoningEffort.trim() &&
    typeof review.additionalInstructions === 'string'
  ) {
    out.autoLoopFinalReview = {
      engine: review.engine,
      model: review.model,
      reasoningEffort: review.reasoningEffort,
      additionalInstructions: review.additionalInstructions,
    }
  }
  if (isPlainObject(raw.reasoningEffortByModel)) {
    const entries = Object.entries(raw.reasoningEffortByModel).filter(
      ([model, effort]) => model.length > 0 && typeof effort === 'string' && effort.length > 0,
    )
    out.reasoningEffortByModel = Object.fromEntries(entries) as Record<string, string>
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
