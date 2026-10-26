import type { CreateElicitationResponse, RequestPermissionResponse, ToolCall } from '@agentclientprotocol/sdk'
import { isOperationApprovalAvailable } from '../../../workspace-permission-policy-service.js'
import { type AgentEvent, type PendingUserInputResponse, PendingUserInputValidationError } from '../types.js'
import type { VibeAcpHandlers } from './client.js'

type Field = {
  id: string
  question: string
  header?: string
  options: { label: string; description?: string }[]
  required: boolean
  freeText: boolean
  multiSelect: boolean
  isOther: false
  min: number
  max: number
}
type Pending = { answer: (response: PendingUserInputResponse) => boolean; cancel: () => void }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function text(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && value.length <= max
}
function bound(value: unknown, fallback: number, ceiling: number): number | undefined {
  if (value == null) return fallback
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= ceiling ? value : undefined
}
function choices(schema: Record<string, unknown>, titledKey: 'oneOf' | 'anyOf'): Field['options'] | undefined {
  if (schema.enum != null && schema[titledKey] != null) return undefined
  let options: Field['options']
  if (Array.isArray(schema.enum) && schema.enum.every((value) => text(value, 2000))) {
    options = schema.enum.map((label) => ({ label }))
  } else if (Array.isArray(schema[titledKey])) {
    const values = schema[titledKey]
    if (
      !values.every(
        (v) =>
          record(v) &&
          onlyKeys(v, ['const', 'title', 'description', '_meta']) &&
          text(v.const, 2000) &&
          text(v.title, 2000) &&
          (v.description == null || text(v.description)),
      )
    )
      return undefined
    options = values.map((v) => ({ label: v.const as string, description: (v.description ?? v.title) as string }))
  } else return undefined
  if (!options.length || options.length > 32 || new Set(options.map((o) => o.label)).size !== options.length)
    return undefined
  return options
}

function formFields(schema: unknown): Field[] | undefined {
  if (
    !record(schema) ||
    !onlyKeys(schema, ['type', 'title', 'description', 'properties', 'required', '_meta']) ||
    (schema.type != null && schema.type !== 'object') ||
    !record(schema.properties)
  )
    return undefined
  const entries = Object.entries(schema.properties)
  if (!entries.length || entries.length > 20) return undefined
  const required = schema.required ?? []
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key)) ||
    new Set(required).size !== required.length
  )
    return undefined
  const fields: Field[] = []
  for (const [id, property] of entries) {
    if (
      !id ||
      !text(id, 200) ||
      !record(property) ||
      (property.title != null && !text(property.title)) ||
      (property.description != null && !text(property.description))
    )
      return undefined
    const multiSelect = property.type === 'array'
    if (property.type !== 'string' && !multiSelect) return undefined
    if (
      !onlyKeys(
        property,
        multiSelect
          ? ['type', 'title', 'description', 'items', 'minItems', 'maxItems', 'default', '_meta']
          : [
              'type',
              'title',
              'description',
              'minLength',
              'maxLength',
              'enum',
              'oneOf',
              'default',
              'pattern',
              'format',
              '_meta',
            ],
      )
    )
      return undefined
    // Pattern/format constraints need native validation support before they can be rendered safely.
    if (property.pattern != null || property.format != null) return undefined
    let options: Field['options'] = []
    if (multiSelect) {
      if (
        !record(property.items) ||
        !onlyKeys(property.items, ['type', 'enum', 'anyOf', '_meta']) ||
        (property.items.type != null && property.items.type !== 'string')
      )
        return undefined
      const parsed = choices(property.items, 'anyOf')
      if (!parsed) return undefined
      options = parsed
    } else if (property.enum != null || property.oneOf != null) {
      const parsed = choices(property, 'oneOf')
      if (!parsed) return undefined
      options = parsed
    }
    const min = bound(multiSelect ? property.minItems : property.minLength, 0, multiSelect ? options.length : 10000)
    const max = bound(
      multiSelect ? property.maxItems : property.maxLength,
      multiSelect ? options.length : 10000,
      multiSelect ? options.length : 10000,
    )
    if (min === undefined || max === undefined || min > max) return undefined
    fields.push({
      id,
      question: (property.description ?? property.title ?? id) as string,
      ...(property.title ? { header: property.title as string } : {}),
      options,
      required: required.includes(id),
      freeText: !multiSelect && !options.length,
      multiSelect,
      isOther: false,
      min,
      max,
    })
  }
  return fields
}

function formAnswer(
  fields: Field[],
  response: Extract<PendingUserInputResponse, { kind: 'question' }>,
): CreateElicitationResponse | undefined {
  if (!record(response.answers) || (response.selections !== undefined && !record(response.selections))) return undefined
  if (
    Object.keys(response.answers).some((id) => !fields.some((field) => field.id === id)) ||
    Object.keys(response.selections ?? {}).some((id) => !fields.some((field) => field.id === id && field.multiSelect))
  )
    return undefined
  const content: [string, string | string[]][] = []
  for (const field of fields) {
    const source = field.multiSelect ? response.selections : response.answers
    if (!source || !Object.hasOwn(source, field.id)) {
      if (field.required || Object.hasOwn(response.answers, field.id)) return undefined
      continue
    }
    const value = source[field.id]
    if (field.multiSelect) {
      if (
        !Array.isArray(value) ||
        value.length < field.min ||
        value.length > field.max ||
        new Set(value).size !== value.length ||
        value.some((v) => !text(v, 2000) || !field.options.some((o) => o.label === v))
      )
        return undefined
      content.push([field.id, [...value]])
    } else {
      if (
        !text(value, field.max) ||
        value.length < field.min ||
        (!field.freeText && !field.options.some((o) => o.label === value))
      )
        return undefined
      content.push([field.id, value])
    }
  }
  return { action: 'accept', content: Object.fromEntries(content) }
}

export function createMistralServerRequests(args: {
  sessionId: string
  readOnly: boolean
  emit: (event: AgentEvent) => void
  getTool: (nativeToolCallId: string) => ToolCall | undefined
  canonicalToolCallId: (nativeToolCallId: string) => string
  autoApprove?: (toolName: string, payload: unknown) => boolean
  onPendingChange?: (count: number) => void
}): Required<Pick<VibeAcpHandlers, 'requestPermission' | 'createElicitation'>> & {
  hasPendingUserInput(toolCallId: string): boolean
  resolvePendingUserInput(toolCallId: string, response: PendingUserInputResponse): boolean
  cancelAll(): void
} {
  const pending = new Map<string, Pending>()
  const seen = new Set<string>()
  let closed = false

  function wait<T>(
    key: string,
    signal: AbortSignal,
    cancelled: T,
    answer: (response: PendingUserInputResponse) => T | undefined,
    event: AgentEvent,
  ): Promise<T> {
    return new Promise((resolve) => {
      function settle(result: T) {
        if (!pending.delete(key)) return
        signal.removeEventListener('abort', cancel)
        resolve(result)
        args.onPendingChange?.(pending.size)
      }
      const cancel = () => settle(cancelled)
      pending.set(key, {
        cancel,
        answer: (response) => {
          const result = answer(response)
          if (result === undefined) throw new PendingUserInputValidationError()
          settle(result)
          return true
        },
      })
      seen.add(key)
      signal.addEventListener('abort', cancel, { once: true })
      args.onPendingChange?.(pending.size)
      if (pending.has(key)) args.emit(event)
    })
  }
  function unavailable(key: string, signal: AbortSignal): boolean {
    return closed || signal.aborted || seen.has(key) || pending.size >= 32 || seen.size >= 4096
  }

  return {
    requestPermission({ params, signal }) {
      const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
      if (closed || signal.aborted || args.readOnly || params.sessionId !== args.sessionId) return cancelled
      const tool = args.getTool(params.toolCall.toolCallId)
      const toolName = tool?._meta?.tool_name
      if (!tool || typeof toolName !== 'string' || !toolName.trim() || toolName.length > 200) return cancelled
      const key = args.canonicalToolCallId(params.toolCall.toolCallId)
      if (unavailable(key, signal)) return cancelled
      const offered = params.options
      if (
        !offered.length ||
        offered.some((option) => !option.optionId) ||
        new Set(offered.map((option) => option.optionId)).size !== offered.length
      )
        return cancelled
      const allow = offered.find((option) => option.kind === 'allow_once')
      const deny = offered.find((option) => option.kind === 'reject_once')
      if (!allow || !deny) return cancelled
      const payload = {
        rawInput: tool.rawInput ?? null,
        effectKind: tool._meta?.effect_kind ?? null,
        kind: tool.kind ?? null,
        operationApprovalAvailable: false,
      }
      payload.operationApprovalAvailable = isOperationApprovalAvailable({
        engine: 'mistral-vibe',
        toolName,
        payload: { ...payload, operationApprovalAvailable: true },
      })
      const selected = (optionId: string): RequestPermissionResponse => ({ outcome: { outcome: 'selected', optionId } })
      const approved = args.autoApprove?.(toolName, payload)
      if (closed || signal.aborted) return cancelled
      if (approved) {
        seen.add(key)
        return selected(allow.optionId)
      }
      return wait(
        key,
        signal,
        cancelled,
        (response) =>
          response.kind === 'permission-allow'
            ? selected(allow.optionId)
            : response.kind === 'permission-deny'
              ? selected(deny.optionId)
              : undefined,
        { kind: 'session:user-input-requested', requestKind: 'permission', toolCallId: key, toolName, payload },
      )
    },
    createElicitation({ params, signal, requestId }) {
      if (closed || signal.aborted || args.readOnly) return { action: 'cancel' }
      if (
        params.mode !== 'form' ||
        !('sessionId' in params) ||
        params.sessionId !== args.sessionId ||
        !text(params.message)
      )
        return { action: 'decline' }
      const fields = formFields(params.requestedSchema)
      if (!fields) return { action: 'decline' }
      const nativeId = typeof params.toolCallId === 'string' ? params.toolCallId : ''
      const key = `${args.canonicalToolCallId(nativeId)}:elicitation:${typeof requestId}:${encodeURIComponent(String(requestId))}`
      if (unavailable(key, signal)) return { action: 'decline' }
      return wait<CreateElicitationResponse>(
        key,
        signal,
        { action: 'cancel' },
        (response) =>
          response.kind === 'question-cancel'
            ? { action: 'cancel' }
            : response.kind === 'question'
              ? formAnswer(fields, response)
              : undefined,
        {
          kind: 'session:user-input-requested',
          requestKind: 'question',
          toolCallId: key,
          toolName: 'AskUserQuestion',
          payload: {
            questions: fields.map(({ min, max, ...field }) => ({
              ...field,
              ...(field.multiSelect ? { minItems: min, maxItems: max } : { minLength: min, maxLength: max }),
            })),
          },
        },
      )
    },
    hasPendingUserInput(toolCallId) {
      return pending.has(toolCallId)
    },
    resolvePendingUserInput(toolCallId, response) {
      return pending.get(toolCallId)?.answer(response) ?? false
    },
    cancelAll() {
      closed = true
      for (const entry of pending.values()) entry.cancel()
    },
  }
}
