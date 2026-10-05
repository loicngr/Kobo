import type { MemoryActor, MemoryScopeCatalogueItem, MemoryTransport } from '../../shared/memory.js'
import { deriveMemoryActor } from '../../shared/memory.js'
import { isMemoryToolName, validateMemoryToolArguments } from '../../shared/memory-tools.js'
import type { MessageSource } from '../../shared/workspace-message-types.js'
import {
  prepareMemoryControlReply,
  prepareMemoryToolEnvelope,
  sliceMemoryBodyFragment,
} from '../utils/memory-token-budget.js'
import {
  createExternalMemoryBudgetContext,
  reserveMemoryBudget,
  reserveMemoryBudgetDenial,
  wasMemoryFragmentDelivered,
} from './memory-budget-service.js'
import {
  listMemories,
  listMemoryOperations,
  listMemoryScopes,
  listWorkspaceMemoryOperations,
  readMemory,
  remember,
  searchMemories,
} from './memory-service.js'

function externalActor(source: MessageSource): MemoryActor {
  if (source.kind !== 'mcp') throw new TypeError('External memory tools require MCP client context')
  return deriveMemoryActor({ kind: 'external-mcp', clientName: source.clientName, transport: source.transport })
}

function selectedScope(args: Record<string, unknown>): { scopeId?: string; workspaceId?: string } {
  const scopeId = args.scope_id as string | undefined
  const workspaceId = args.workspace_id as string | undefined
  if (Boolean(scopeId) === Boolean(workspaceId)) throw new TypeError('Specify exactly one scope_id or workspace_id')
  return { ...(scopeId ? { scopeId } : {}), ...(workspaceId ? { workspaceId } : {}) }
}

function compactWriteReceipt(result: ReturnType<typeof remember>) {
  if (result.status === 'denied') return { status: 'denied', reason: result.reason }
  if (result.status === 'proposed') {
    return {
      status: 'proposed' as const,
      proposalId: result.proposal.id,
      scopeId: result.proposal.scopeId,
      generation: result.proposal.generation,
      ...(result.proposal.targetEntryId ? { entryId: result.proposal.targetEntryId } : {}),
      ...(result.proposal.baseRevision !== undefined ? { baseRevision: result.proposal.baseRevision } : {}),
    }
  }
  return {
    status: 'applied' as const,
    entry: {
      id: result.entry.id,
      scopeId: result.entry.scopeId,
      key: result.entry.key,
      revision: result.entry.revision,
      updatedAt: result.entry.updatedAt,
    },
  }
}

function boundedListPage(
  page: ReturnType<typeof listMemories>,
  contextId: string,
): { data: Record<string, unknown>; deliveries: Array<{ entryId: string; revision: number; kind: 'metadata' }> } {
  const deliveries: Array<{ entryId: string; revision: number; kind: 'metadata' }> = []
  return {
    data: {
      totalCount: page.totalCount,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      items: page.items.map((entry) => {
        const metadataDelivery = { entryId: entry.id, revision: entry.revision, kind: 'metadata' as const }
        const alreadyDelivered = wasMemoryFragmentDelivered(contextId, metadataDelivery)
        if (!alreadyDelivered) deliveries.push(metadataDelivery)
        return alreadyDelivered
          ? { id: entry.id, revision: entry.revision, alreadyDelivered: true }
          : { id: entry.id, scopeId: entry.scopeId, key: entry.key, title: entry.title, revision: entry.revision }
      }),
    },
    deliveries,
  }
}

function boundedOperations(page: ReturnType<typeof listMemoryOperations>): Record<string, unknown> {
  return {
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    items: page.items.map((operation) => ({
      id: operation.id,
      scopeId: operation.scopeId,
      kind: operation.kind,
      actor: {
        kind: operation.actor.kind,
        ...(operation.actor.kind === 'external-mcp'
          ? { clientName: operation.actor.clientName, transport: operation.actor.transport }
          : {}),
      },
      createdAt: operation.createdAt,
    })),
  }
}

function boundedScopes(page: ReturnType<typeof listMemoryScopes>): {
  nextCursor?: string
  items: MemoryScopeCatalogueItem[]
} {
  return {
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    items: page.items.map((scope) => ({
      id: scope.id,
      level: scope.level,
      generation: scope.generation,
      revision: scope.revision,
    })),
  }
}

function readFragment(args: Record<string, unknown>, scopeId: string, actor: MemoryActor, budgetId: string) {
  const entry = readMemory({ scopeId, entryId: args.entry_id as string, actor })
  const cursor: string | undefined = args.cursor as string | undefined
  let offset = 0
  if (cursor) offset = Number(cursor.split('.')[1])
  const delivery = {
    entryId: entry.id,
    revision: entry.revision,
    kind: 'body-fragment' as const,
    start: offset,
    end: offset + 40,
  }
  const alreadyDelivered = wasMemoryFragmentDelivered(budgetId, delivery)
  const fragment = sliceMemoryBodyFragment({
    body: entry.body,
    revision: entry.revision,
    ...(cursor ? { cursor } : {}),
    alreadyDelivered,
    repeat: args.repeat === true,
  })
  return {
    data: {
      entry: {
        id: entry.id,
        key: entry.key,
        title: entry.title,
        revision: entry.revision,
        ...(fragment.text !== undefined ? { body: fragment.text } : {}),
        truncated: fragment.truncated,
        totalCodePoints: fragment.totalCodePoints,
        offset: fragment.offset,
        ...(fragment.nextCursor ? { nextCursor: fragment.nextCursor } : {}),
        ...(fragment.alreadyDelivered ? { alreadyDelivered: true } : {}),
      },
    },
    delivery: fragment.text !== undefined ? { ...delivery, end: offset + [...fragment.text].length } : undefined,
  }
}

function addBudgetReceipt(
  data: Record<string, unknown>,
  contextId: string,
  estimatedTokens: number,
  remaining: number,
) {
  return {
    ...data,
    memory_context_id: contextId,
    budget: {
      estimatedTokens,
      remainingTokens: remaining,
      exhausted: remaining <= 0,
    },
  }
}

function chargeExternalOutput(input: {
  data: Record<string, unknown>
  contextId: string
  source: MessageSource
  delivery?: { entryId: string; revision: number; kind: 'body-fragment'; start: number; end: number }
  deliveries?: Array<{ entryId: string; revision: number; kind: 'metadata' | 'excerpt'; start?: number; end?: number }>
  pageOffset?: number
}): Record<string, unknown> {
  // Use a worst-case fixed-width receipt while sizing, then reserve before the
  // result leaves the server. The external estimate counts text + structuredContent.
  const sized = prepareMemoryToolEnvelope(addBudgetReceipt(input.data, input.contextId, 1_000, 6_000), {
    targetTokens: 1_000,
    transport: 'external',
    pageOffset: input.pageOffset,
  })
  const emittedItems = Array.isArray(sized.data.items) ? sized.data.items : []
  const emittedIds = new Set(
    emittedItems
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => item.id),
  )
  const emittedDelivery = input.delivery
    ? (() => {
        const body = (sized.data.entry as Record<string, unknown> | undefined)?.body
        if (typeof body !== 'string') return undefined
        return { ...input.delivery!, end: input.delivery!.start + [...body].length }
      })()
    : undefined
  const emittedDeliveries = (input.deliveries ?? []).filter((delivery) => emittedIds.has(delivery.entryId))
  const reservation = reserveMemoryBudget({
    budgetContextId: input.contextId,
    estimatedTokens: sized.estimatedTokens,
    responseLimitTokens: 1_000,
    ...(emittedDelivery ? { delivery: emittedDelivery } : {}),
    ...(emittedDeliveries.length ? { deliveries: emittedDeliveries } : {}),
  })
  if (!reservation.accepted) {
    const denial = prepareMemoryToolEnvelope(
      {
        memory_context_id: input.contextId,
        budgetExhausted: true,
        message: 'Lectures épuisées; remember reste disponible.',
      },
      { targetTokens: 1_000, transport: 'external' },
    )
    const denialReservation = reserveMemoryBudgetDenial(input.contextId, denial.estimatedTokens)
    return denialReservation.responseAllowed ? denial.data : { memoryOutputSuppressed: true }
  }
  return addBudgetReceipt(sized.data, input.contextId, reservation.estimatedTokens, reservation.remainingTokens)
}

/** Execute the external memory surface; caller identity is always derived from MCP transport. */
export function executeMemoryMcpTool(name: string, input: unknown, source: MessageSource): unknown {
  if (!isMemoryToolName(name)) throw new TypeError(`Unknown memory tool '${name}'`)
  const actor = externalActor(source)
  const transport = source.transport as MemoryTransport
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('Memory tool arguments must be an object')
  const rawArgs = input as Record<string, unknown>
  const context = createExternalMemoryBudgetContext(
    typeof rawArgs.memory_context_id === 'string' ? rawArgs.memory_context_id : undefined,
    actor.kind === 'external-mcp' ? actor.clientName : 'External MCP client',
    transport,
  )
  const controlReply = name === 'remember' || name === 'list_memory_scopes'
  const controlResult = (data: Record<string, unknown>, pageOffset?: number) =>
    prepareMemoryControlReply({ ...data, memory_context_id: context.id }, 'external', pageOffset)
  let args: Record<string, unknown>
  try {
    args = validateMemoryToolArguments(name, input, true)
  } catch (error) {
    if (controlReply)
      return controlResult({ error: error instanceof Error ? error.message : String(error), __mcpError: true })
    const charged = chargeExternalOutput({
      data: { error: error instanceof Error ? error.message : String(error) },
      contextId: context.id,
      source,
    })
    return { ...charged, __mcpError: true }
  }
  const cursor = args.cursor as string | undefined
  const limit = args.limit as number | undefined
  const selection = ['list_memories', 'search_memories', 'list_memory_operations'].includes(name)
    ? selectedScope(args)
    : undefined
  let data: Record<string, unknown>
  let delivery: Parameters<typeof chargeExternalOutput>[0]['delivery']
  let deliveries: Parameters<typeof chargeExternalOutput>[0]['deliveries']

  try {
    switch (name) {
      case 'list_memory_scopes':
        data = boundedScopes(
          listMemoryScopes({
            ...(args.workspace_id ? { workspaceId: args.workspace_id as string } : {}),
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          }),
        )
        break
      case 'list_memories': {
        const page = listMemories({ ...selection!, actor, ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) })
        const bounded = boundedListPage(page, context.id)
        data = bounded.data
        deliveries = bounded.deliveries
        break
      }
      case 'read_memory': {
        const result = readFragment(args, args.scope_id as string, actor, context.id)
        data = result.data
        delivery = result.delivery
        break
      }
      case 'search_memories': {
        if (selection!.scopeId) {
          const page = searchMemories({
            scopeId: selection!.scopeId,
            query: args.query as string,
            actor,
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          })
          const bounded = boundedListPage(page, context.id)
          data = bounded.data
          deliveries = bounded.deliveries
        } else {
          const page = listMemories({
            workspaceId: selection!.workspaceId,
            actor,
            query: args.query as string,
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          })
          const bounded = boundedListPage(page, context.id)
          data = bounded.data
          deliveries = bounded.deliveries
        }
        break
      }
      case 'list_memory_operations': {
        const page = selection!.scopeId
          ? listMemoryOperations({
              scopeId: selection!.scopeId,
              actor,
              ...(cursor ? { cursor } : {}),
              ...(limit ? { limit } : {}),
            })
          : listWorkspaceMemoryOperations(selection!.workspaceId!, {
              ...(cursor ? { cursor } : {}),
              ...(limit ? { limit } : {}),
            })
        data = boundedOperations(page)
        break
      }
      case 'remember':
        data = compactWriteReceipt(
          remember({
            scopeId: args.scope_id as string,
            expectedGeneration: args.expected_generation as number,
            key: args.key as string,
            title: args.title as string,
            body: args.body as string,
            actor,
            ...(args.entry_id ? { targetEntryId: args.entry_id as string } : {}),
            ...(args.expected_revision ? { expectedRevision: args.expected_revision as number } : {}),
          }),
        )
        break
    }
  } catch (error) {
    if (controlReply)
      return controlResult({ error: error instanceof Error ? error.message : String(error), __mcpError: true })
    const charged = chargeExternalOutput({
      data: { error: error instanceof Error ? error.message : String(error) },
      contextId: context.id,
      source,
    })
    return { ...charged, __mcpError: true }
  }
  if (controlReply) return controlResult(data, Number(cursor ?? 0))
  return chargeExternalOutput({
    data,
    contextId: context.id,
    source,
    pageOffset: name === 'list_memory_operations' ? undefined : Number(cursor ?? 0),
    ...(delivery ? { delivery } : {}),
    ...(deliveries ? { deliveries } : {}),
  })
}
