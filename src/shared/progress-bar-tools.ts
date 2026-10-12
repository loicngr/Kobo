import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const id = { type: 'string', minLength: 1, maxLength: 200 }
const numberOrNull = { type: ['number', 'null'] }
const step = { type: ['string', 'null'], maxLength: 500 }
const sequence = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: 'Strictly increasing producer sequence. Retry unchanged payload with the same sequence.',
}

function tools(external: boolean): Tool[] {
  const scope: Record<string, object> = external ? { workspace_id: id, session_id: id } : {}
  const requiredScope = external ? ['workspace_id', 'session_id'] : []
  const definition = (
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    readOnly = false,
  ): Tool => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...scope, ...properties },
      required: [...requiredScope, ...required],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
  })
  return [
    definition(
      'create_progress_bar',
      'Start reporting a labelled long-running activity. Save the returned id and sequence, update that same bar at actual phase changes and meaningful completed milestones, and finish it before the final report when the outcome is known. Use a new activity_key per activity; identical retries return its current state, including dismissal. Supply measured current/total together or omit both for indeterminate progress. Closing a bar never cancels work.',
      {
        activity_key: { type: 'string', minLength: 1, maxLength: 100 },
        label: { type: 'string', minLength: 1, maxLength: 200 },
        step,
        current: numberOrNull,
        total: numberOrNull,
      },
      ['activity_key', 'label'],
    ),
    definition(
      'update_progress_bar',
      'Update the existing bar at actual phase changes or meaningful completed milestones, even when no percentage is known. Omit both numbers for step-only updates (previous numeric values are preserved); provide both measured numbers together, or both null to switch to indeterminate. Use the returned id as progress_id and increase sequence. Never invent percentages or send unchanged updates. At most one accepted running update per second; respect retry guidance without polling. Dismissed bars remain hidden.',
      { progress_id: id, sequence, step, current: numberOrNull, total: numberOrNull },
      ['progress_id', 'sequence'],
    ),
    definition(
      'finish_progress_bar',
      'Finish the same bar with succeeded or failed before your final report or return to the parent, only once the activity outcome is known. Do not finish ongoing background work merely because you yield control. Increase sequence; terminal state is immutable except an exact retry. Success hides after five seconds; failure remains until the user closes it. Reporting does not mark workspace tasks done.',
      { progress_id: id, sequence, step, outcome: { type: 'string', enum: ['succeeded', 'failed'] } },
      ['progress_id', 'sequence', 'outcome'],
    ),
    definition(
      'list_progress_bars',
      'Read progress bars in the explicitly selected session, including dismissed/terminal bars. Responses contain bounded pages and serverTime; do not poll without a concrete need.',
      {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      [],
      true,
    ),
  ]
}

export const PROGRESS_BAR_TOOLS: Tool[] = tools(true)
export const INTERNAL_PROGRESS_BAR_TOOLS: Tool[] = tools(false)
export function isProgressBarTool(name: string): boolean {
  return PROGRESS_BAR_TOOLS.some((tool) => tool.name === name)
}

/** Shared transport validation; numeric relationships and scope ownership remain server-owned. */
export function validateProgressBarArguments(name: string, input: unknown, external: boolean): Record<string, unknown> {
  const definition = (external ? PROGRESS_BAR_TOOLS : INTERNAL_PROGRESS_BAR_TOOLS).find((tool) => tool.name === name)
  if (!definition) throw new TypeError('Unknown progress tool')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected an object')
  const args = input as Record<string, unknown>
  const properties = definition.inputSchema.properties ?? {}
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) throw new TypeError(`Unknown argument: ${key}`)
    const schema = properties[key] as {
      type: string | string[]
      minLength?: number
      maxLength?: number
      minimum?: number
      maximum?: number
      enum?: unknown[]
    }
    const value = args[key]
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const validType = types.some((type) =>
      type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type,
    )
    if (
      !validType ||
      (typeof value === 'number' &&
        (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) ||
      (typeof value === 'string' &&
        (value.trim().length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) ||
      (schema.enum && !schema.enum.includes(value))
    )
      throw new TypeError(`Invalid argument: ${key}`)
  }
  for (const key of definition.inputSchema.required ?? [])
    if (args[key] === undefined) throw new TypeError(`Missing argument: ${key}`)
  return args
}
