import type {
  PromptResponse,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
  UsageUpdate,
} from '@agentclientprotocol/sdk'
import { createStreamingBatcher } from '../../streaming-batcher.js'
import type { AgentEvent } from '../types.js'

export interface MistralUsageBaseline {
  inputTokens: number
  outputTokens: number
  costUsd?: number
}

export interface MistralEventMapper {
  onUpdate(notification: SessionNotification): void
  /** Lookup uses the native ID and returns native ACP metadata, never a display-name inference. */
  getTool(nativeToolCallId: string): ToolCall | undefined
  /** Use this same ID for permission callbacks and outward tool events. */
  canonicalToolCallId(nativeToolCallId: string): string
  beginLive(baseline?: MistralUsageBaseline): void
  finish(result: PromptResponse): void
  /** Drain text and known terminal tools at EOF; never fabricate unfinished tool results. */
  flush(): void
}

type Tokens = Pick<MistralUsageBaseline, 'inputTokens' | 'outputTokens'>
type TrackedTool = {
  tool: ToolCall
  hasMetadata: boolean
  callReady: boolean
  callEmitted: boolean
  resultEmitted: boolean
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validTokens(inputTokens: unknown, outputTokens: unknown): Tokens | undefined {
  return typeof inputTokens === 'number' &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === 'number' &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens >= 0
    ? { inputTokens, outputTokens }
    : undefined
}

function validCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function toolName(tool: ToolCall): string | undefined {
  const name = tool._meta?.tool_name
  return typeof name === 'string' && name.trim() ? name : tool.name?.trim() || undefined
}

const BRAINSTORM_COMPLETE = '[BRAINSTORM_COMPLETE]'

/** One owned session and prompt per launch; the engine filters native session IDs before dispatch. */
export function createMistralEventMapper(launchId: string, emit: (event: AgentEvent) => void): MistralEventMapper {
  const scoped = (kind: string, id: string) => `vibe:${encodeURIComponent(launchId)}:${kind}:${encodeURIComponent(id)}`
  const canonicalToolCallId = (nativeId: string) => scoped('tool', nativeId)
  const batcher = createStreamingBatcher(emit)
  const tools = new Map<string, TrackedTool>()
  const compactions = new Map<string, string>()
  let live = false
  let finished = false
  let messageId: string | undefined
  let messageKind: 'agent_message_chunk' | 'agent_thought_chunk' | undefined
  let messageSequence = 0
  let planSequence = 0
  let brainstormTail = ''
  let brainstormEmitted = false
  let baseline: Tokens | undefined
  let baselineCost: number | undefined
  let latest: Tokens | undefined
  let latestCost: number | undefined
  let sawLiveTokens = false
  let sawLiveCost = false
  let tokensReset = false
  let costReset = false

  function captureTokens(input: unknown, output: unknown): void {
    const tokens = validTokens(input, output)
    if (!tokens) {
      if (live) tokensReset = true
      else latest = undefined
      return
    }
    if (live) {
      sawLiveTokens = true
      if (latest && (tokens.inputTokens < latest.inputTokens || tokens.outputTokens < latest.outputTokens))
        tokensReset = true
    }
    latest = tokens
  }

  function captureUsage(update: UsageUpdate): void {
    const meta = update._meta
    if (meta && ('promptTokens' in meta || 'completionTokens' in meta))
      captureTokens(meta.promptTokens, meta.completionTokens)
    if (update.cost) {
      if (update.cost.currency !== 'USD' || !validCost(update.cost.amount)) {
        if (live) costReset = true
        else latestCost = undefined
      } else {
        if (live) {
          sawLiveCost = true
          if (latestCost !== undefined && update.cost.amount < latestCost) costReset = true
        }
        latestCost = update.cost.amount
      }
    }
  }

  function closeMessage(): void {
    if (messageId) batcher.push({ kind: 'message:end', messageId })
    messageId = undefined
    messageKind = undefined
    brainstormTail = ''
  }

  function emitTool(tracked: TrackedTool, force = false): void {
    if ((!tracked.callReady && !force) || tracked.resultEmitted) return
    const { tool } = tracked
    const toolCallId = canonicalToolCallId(tool.toolCallId)
    if (!tracked.callEmitted) {
      tracked.callEmitted = true
      batcher.push({
        kind: 'tool:call',
        messageId: '',
        toolCallId,
        name: toolName(tool) ?? (tool.title || 'Tool'),
        input: tool.rawInput,
      })
    }
    if (tool.status === 'completed' || tool.status === 'failed') {
      tracked.resultEmitted = true
      const output =
        tool.content?.length || tool.locations?.length
          ? {
              ...(tool.rawOutput !== undefined ? { rawOutput: tool.rawOutput } : {}),
              ...(tool.content?.length ? { content: tool.content } : {}),
              ...(tool.locations?.length ? { locations: tool.locations } : {}),
            }
          : (tool.rawOutput ?? null)
      batcher.push({ kind: 'tool:result', toolCallId, output, isError: tool.status === 'failed' })
    }
  }

  function mergeTool(update: ToolCallUpdate & { sessionUpdate: 'tool_call' | 'tool_call_update' }): void {
    let tracked = tools.get(update.toolCallId)
    if (!tracked) {
      tracked = {
        tool: { toolCallId: update.toolCallId, title: '' },
        hasMetadata: false,
        callReady: false,
        callEmitted: false,
        resultEmitted: false,
      }
      tools.set(update.toolCallId, tracked)
    }
    if (tracked.resultEmitted) return
    const tool = tracked.tool
    const terminal = tool.status === 'completed' || tool.status === 'failed'
    if (update.title != null) tool.title = update.title
    if (update.name != null) tool.name = update.name
    if (update.kind != null) tool.kind = update.kind
    if (update.status != null && !terminal) tool.status = update.status
    if (update.rawInput !== undefined) tool.rawInput = update.rawInput
    if (update.rawOutput !== undefined && (!terminal || tool.rawOutput === undefined)) tool.rawOutput = update.rawOutput
    if (update.content !== undefined) tool.content = update.content ?? undefined
    if (update.locations !== undefined) tool.locations = update.locations ?? undefined
    if (update._meta !== undefined) tool._meta = update._meta === null ? undefined : { ...tool._meta, ...update._meta }
    tracked.hasMetadata ||= update.title != null || toolName(tool) !== undefined
    tracked.callReady ||=
      update.sessionUpdate === 'tool_call' || (toolName(tool) !== undefined && tool.rawInput !== undefined)
    emitTool(tracked)
  }

  function flush(): void {
    if (!live) return
    closeMessage()
    for (const tracked of tools.values()) emitTool(tracked, true)
    batcher.close()
  }

  return {
    canonicalToolCallId,
    getTool(nativeId) {
      const tracked = tools.get(nativeId)
      return tracked?.hasMetadata ? tracked.tool : undefined
    },
    beginLive(explicit) {
      if (live || finished) return
      baseline = explicit ? validTokens(explicit.inputTokens, explicit.outputTokens) : latest
      baselineCost = explicit ? (validCost(explicit.costUsd) ? explicit.costUsd : undefined) : latestCost
      latest = baseline
      latestCost = baselineCost
      live = true
    },
    onUpdate({ update }) {
      if (finished) return
      if (update.sessionUpdate === 'usage_update') {
        captureUsage(update)
        return
      }
      if (!live) return
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk': {
          if (update.content.type !== 'text') return
          if (messageKind && messageKind !== update.sessionUpdate) closeMessage()
          const nextId = update.messageId
            ? scoped('message', update.messageId)
            : (messageId ?? scoped('anonymous-message', String(++messageSequence)))
          if (messageId && messageId !== nextId) closeMessage()
          messageId = nextId
          messageKind = update.sessionUpdate
          if (update.sessionUpdate === 'agent_thought_chunk') {
            batcher.close()
            batcher.push({ kind: 'message:thinking', messageId, text: update.content.text, streaming: true })
          } else {
            batcher.push({ kind: 'message:text', messageId, text: update.content.text, streaming: true })
            if (!brainstormEmitted) {
              const text = brainstormTail + update.content.text
              if (text.includes(BRAINSTORM_COMPLETE)) {
                brainstormEmitted = true
                batcher.push({ kind: 'session:brainstorm-complete' })
              }
              brainstormTail = text.slice(-(BRAINSTORM_COMPLETE.length - 1))
            }
          }
          return
        }
        case 'tool_call':
        case 'tool_call_update':
          closeMessage()
          mergeTool(update)
          return
        case 'plan': {
          closeMessage()
          const toolCallId = scoped('plan', String(++planSequence))
          batcher.push({
            kind: 'tool:call',
            messageId: '',
            toolCallId,
            name: 'TodoWrite',
            input: { todos: update.entries.map(({ content, status }) => ({ content, status })) },
          })
          batcher.push({ kind: 'tool:result', toolCallId, output: null, isError: false })
          return
        }
        case 'notice':
          if (update.severity === 'error')
            batcher.push({ kind: 'error', category: 'other', message: update.description || update.title })
          return
        case 'compaction_update': {
          const previous = compactions.get(update.compactionId)
          if (previous === update.status || (previous && previous !== 'in_progress')) return
          const compactionId = scoped('compaction', update.compactionId)
          if (update.status === 'in_progress') {
            compactions.set(update.compactionId, update.status)
            batcher.push({ kind: 'session:compacting', active: true, compactionId })
          } else if (['completed', 'failed', 'cancelled'].includes(update.status)) {
            compactions.set(update.compactionId, update.status)
            batcher.push({ kind: 'session:compacting', active: false, compactionId })
            if (update.status === 'completed') batcher.push({ kind: 'session:compacted', compactionId })
          }
          return
        }
      }
    },
    finish(result) {
      if (!live || finished) return
      // Stable SDK responses are unchecked; native cumulative usage is not in PromptResponse's type.
      const response = object(result)
      const nativeUsage = object(response?.usage)
      if (nativeUsage && ('inputTokens' in nativeUsage || 'outputTokens' in nativeUsage))
        captureTokens(nativeUsage.inputTokens, nativeUsage.outputTokens)
      flush()
      finished = true
      if (baseline && latest && sawLiveTokens && !tokensReset) {
        batcher.push({
          kind: 'usage',
          inputTokens: latest.inputTokens - baseline.inputTokens,
          outputTokens: latest.outputTokens - baseline.outputTokens,
          ...(baselineCost !== undefined && latestCost !== undefined && sawLiveCost && !costReset
            ? { costUsd: latestCost - baselineCost }
            : {}),
        })
      }
      const stopReason = response?.stopReason
      if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests' || stopReason === 'refusal') {
        batcher.push({
          kind: 'error',
          category: 'other',
          message: `Vibe prompt stopped: ${stopReason}`,
          code: `acp_${stopReason}`,
        })
      } else if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
        batcher.push({ kind: 'error', category: 'parse_error', message: 'Invalid Vibe ACP prompt stop reason' })
      }
    },
    flush,
  }
}
