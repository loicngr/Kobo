import { SLACK_BUTTON_LABEL_LIMIT } from '../../../shared/slack-tools.js'

/** Hard Block Kit limit of a checkbox group; also used for buttons to keep one rule. */
export const MAX_QUESTION_CONTROLS = 10

export const QUESTION_TEXT = {
  orReply: 'Or reply in this thread with your own answer.',
  reply: 'Reply in this thread with your answer.',
  secret: 'The agent asks for a value that must be entered in Kōbō.',
  notAccepted: 'This answer was not accepted. Answer in Kōbō.',
  failed: 'Kōbō could not submit this answer. Answer in Kōbō.',
  handledElsewhere: 'No longer pending - handled in Kōbō.',
  restarted: 'No longer pending - Kōbō restarted.',
  permission: (toolName: string) => `The agent is waiting for an approval in Kōbō (tool: ${toolName}).`,
}

/** One question of an engine's normalised `AskUserQuestion` input, engine differences resolved. */
export interface MirroredQuestion {
  /** The `answers` key: `id` (Codex, Vibe) or the question text (Claude). */
  key: string
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiple: boolean
  /** A text reply in the thread is accepted as the answer. */
  freeText: boolean
}

/** What a question message shows under its text. */
export interface QuestionControls {
  question: number
  kind: 'buttons' | 'checkboxes' | 'none'
  labels: string[]
  hint?: string
}

export interface CollectedAnswer {
  values: string[]
  text: boolean
  by: string
  /** The Slack ts of a text reply, so its reaction can be taken back if the submission fails. */
  ts?: string
}

/** Shortens a control label to Slack's limit without splitting a surrogate pair. */
function shortLabel(label: string): string {
  if (label.length <= SLACK_BUTTON_LABEL_LIMIT) return label
  const high = label.charCodeAt(SLACK_BUTTON_LABEL_LIMIT - 1)
  return label.slice(0, high >= 0xd800 && high <= 0xdbff ? SLACK_BUTTON_LABEL_LIMIT - 1 : SLACK_BUTTON_LABEL_LIMIT)
}

const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * Returns the questions of a pending input, `'secret'` when any question asks for a secret value,
 * or null when the input carries no usable question.
 */
export function readQuestions(input: unknown): MirroredQuestion[] | 'secret' | null {
  const raw = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(raw) || !raw.length) return null
  const out: MirroredQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const q = item as Record<string, unknown>
    if (q.isSecret === true) return 'secret'
    if (!str(q.question)) return null
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o): o is { label: string; description?: unknown } => !!o && str((o as { label?: unknown }).label))
      .map((o) => ({ label: o.label, ...(str(o.description) ? { description: o.description } : {}) }))
    out.push({
      key: str(q.id) ? q.id : q.question,
      question: q.question,
      ...(str(q.header) ? { header: q.header } : {}),
      options,
      multiple: q.multiSelect === true,
      // Vibe declares free text per field; Codex only with `isOther` or without options; Claude always.
      freeText: typeof q.freeText === 'boolean' ? q.freeText : q.isOther === false ? options.length === 0 : true,
    })
  }
  return out
}

export function questionText(q: MirroredQuestion): string {
  const lines = [...(q.header ? [`*${q.header}*`] : []), q.question]
  for (const o of q.options) lines.push(`- ${o.label}${o.description ? ` - ${o.description}` : ''}`)
  return lines.join('\n')
}

export function questionControls(q: MirroredQuestion, index: number): QuestionControls {
  const withControls = q.options.length > 0 && q.options.length <= MAX_QUESTION_CONTROLS
  return {
    question: index,
    kind: withControls ? (q.multiple ? 'checkboxes' : 'buttons') : 'none',
    labels: withControls ? q.options.map((o) => shortLabel(o.label)) : [],
    ...(!withControls ? { hint: QUESTION_TEXT.reply } : q.freeText ? { hint: QUESTION_TEXT.orReply } : {}),
  }
}

/**
 * The same encoding as the Kōbō question panel: `answers[key]` is the labels joined with ", ";
 * `selections[key]` exists only for multiple-choice questions (Vibe rejects it on any other field).
 */
export function buildAnswers(
  questions: MirroredQuestion[],
  collected: CollectedAnswer[],
): { answers: Record<string, string>; selections: Record<string, string[]> } {
  const answers: Record<string, string> = Object.create(null)
  const selections: Record<string, string[]> = Object.create(null)
  questions.forEach((q, i) => {
    const values = collected[i]?.values ?? []
    answers[q.key] = values.join(', ')
    if (q.multiple) selections[q.key] = [...values]
  })
  return { answers, selections }
}

/**
 * Errors `answerPendingQuestion` (orchestrator.ts) throws when the question is no longer answerable
 * there: "Question session is no longer active", "No deferred tool use pending", "Expected a deferred
 * question", "Pending question changed", "Workspace ... not found", "No agent running", "... has no
 * active engine process", "Pending question session ... is no longer active", "No pending callback".
 * Pinned against the real messages in orchestrator-defer-permission.test.ts.
 */
const GONE =
  /no longer active|No deferred tool use pending|Pending question changed|Expected a deferred question|No agent running|no active engine process|No pending callback|not found/

export function answerFailure(err: unknown): 'invalid' | 'gone' | 'failed' {
  if (err instanceof Error && err.name === 'PendingUserInputValidationError') return 'invalid'
  if (err instanceof Error && GONE.test(err.message)) return 'gone'
  return 'failed'
}
