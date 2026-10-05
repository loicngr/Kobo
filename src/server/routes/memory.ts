import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { MEMORY_BODY_MAX_CHARS, MEMORY_PAGE_SIZE_MAX, MEMORY_TITLE_MAX_CHARS } from '../../shared/memory.js'
import { isMemoryToolName, validateMemoryToolArguments } from '../../shared/memory-tools.js'
import { getMemoryCapability } from '../services/memory-agent-runtime.js'
import {
  getInternalMemoryBudgetContext,
  reserveMemoryBudget,
  reserveMemoryBudgetDenial,
  wasMemoryFragmentDelivered,
} from '../services/memory-budget-service.js'
import { listMemoryContextRecords } from '../services/memory-context-service.js'
import {
  approveMemoryProposal,
  clearMemoryScope,
  createMemory,
  deleteMemory,
  listMemories,
  listMemoryOperations,
  listMemoryProposals,
  listMemoryScopes,
  listWorkspaceMemoryOperations,
  MemoryConflictError,
  MemoryNotFoundError,
  previewMemoryClear,
  promoteMemory,
  readMemory,
  rejectMemoryProposal,
  remember,
  searchMemories,
  updateMemory,
} from '../services/memory-service.js'
import {
  prepareMemoryControlReply,
  prepareMemoryToolEnvelope,
  sliceMemoryBodyFragment,
} from '../utils/memory-token-budget.js'

const app = new Hono()
const human = { kind: 'human' } as const
const MAX_BODY_BYTES = 16 * 1024

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readJson(c: Context): Promise<JsonObject> {
  let value: unknown
  try {
    value = await c.req.json()
  } catch {
    throw new TypeError('Request body must be valid JSON')
  }
  if (!isObject(value)) throw new TypeError('Request body must be a JSON object')
  return value
}

function requiredString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${name}`)
  return value.trim()
}

function requiredRevision(value: unknown, name = 'revision', minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError(`Invalid ${name}`)
  return value as number
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new TypeError('Invalid page size')
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_PAGE_SIZE_MAX)
    throw new TypeError('Invalid page size')
  return limit
}

function parseCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TypeError('Invalid cursor')
  return value
}

function parseEntry(value: JsonObject, partial = false): { key?: string; title?: string; body?: string } {
  const result: { key?: string; title?: string; body?: string } = {}
  if (!partial || value.key !== undefined) result.key = requiredString(value.key, 'key', 80).toLowerCase()
  if (!partial || value.title !== undefined) result.title = requiredString(value.title, 'title', MEMORY_TITLE_MAX_CHARS)
  if (!partial || value.body !== undefined) {
    if (typeof value.body === 'string' && value.body.length > MEMORY_BODY_MAX_CHARS)
      throw new PayloadTooLargeError('Memory body exceeds the character limit')
    result.body = requiredString(value.body, 'body', MEMORY_BODY_MAX_CHARS)
  }
  if (partial && Object.keys(result).length === 0) throw new TypeError('At least one memory field is required')
  return result
}

class PayloadTooLargeError extends Error {}

function handleError(c: Context, error: unknown): Response {
  if (error instanceof MemoryNotFoundError) return c.json({ error: error.message }, 404)
  if (error instanceof MemoryConflictError) return c.json({ error: error.message }, 409)
  if (error instanceof PayloadTooLargeError) return c.json({ error: error.message }, 413)
  if (error instanceof TypeError) return c.json({ error: error.message }, 400)
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
}

function boundedAgentReply(
  c: Context,
  capability: NonNullable<ReturnType<typeof getMemoryCapability>>,
  value: Record<string, unknown>,
  status: 200 | 400 | 403 | 404 | 409 | 500 = 200,
  deliveries: Array<{
    entryId: string
    revision: number
    kind: 'metadata' | 'excerpt' | 'body-fragment'
    start?: number
    end?: number
  }> = [],
  pageOffset?: number,
): Response {
  let ledger: ReturnType<typeof getInternalMemoryBudgetContext>
  try {
    ledger = getInternalMemoryBudgetContext(capability.conversationKey)
  } catch (error) {
    // Capabilities are normally created alongside their ledger. If stale or
    // malformed runtime state breaks that invariant, preserve the validation
    // status without turning a client error into a 500 or doing any write.
    const bounded = prepareMemoryToolEnvelope(value, { targetTokens: 1_000, transport: 'internal' })
    const statusCode = error instanceof TypeError ? status : 500
    return c.json(bounded.data, { status: statusCode })
  }
  const placeholder = {
    ...value,
    budget: { estimatedTokens: 1_000, remainingTokens: 6_000, exhausted: false },
  }
  const sized = prepareMemoryToolEnvelope(placeholder, { targetTokens: 1_000, transport: 'internal', pageOffset })
  const emittedItems = Array.isArray(sized.data.items) ? sized.data.items : []
  const emittedIds = new Set(
    emittedItems
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => item.id),
  )
  const emittedDeliveries = deliveries.filter((delivery) => {
    if (delivery.kind === 'metadata' || delivery.kind === 'excerpt') return emittedIds.has(delivery.entryId)
    const body = (sized.data.entry as Record<string, unknown> | undefined)?.body
    if (typeof body !== 'string') return false
    delivery.end = delivery.start! + [...body].length
    return true
  })
  const reservation = reserveMemoryBudget({
    budgetContextId: ledger.id,
    estimatedTokens: sized.estimatedTokens,
    responseLimitTokens: 1_000,
    deliveries: emittedDeliveries,
  })
  if (!reservation.accepted) {
    return exhaustedAgentReply(c, capability)
  }
  const result = {
    ...sized.data,
    budget: {
      estimatedTokens: reservation.estimatedTokens,
      remainingTokens: reservation.remainingTokens,
      exhausted: reservation.remainingTokens <= 0,
    },
  }
  const bounded = prepareMemoryToolEnvelope(result, { targetTokens: 1_000, transport: 'internal' })
  return c.json(bounded.data, { status })
}

function exhaustedAgentReply(
  c: Context,
  capability: NonNullable<ReturnType<typeof getMemoryCapability>>,
  message = 'Lectures épuisées; remember reste disponible.',
): Response {
  const ledger = getInternalMemoryBudgetContext(capability.conversationKey)
  const denial = prepareMemoryToolEnvelope(
    {
      budgetExhausted: true,
      message,
      remainingTokens: 0,
      limitTokens: 6_000,
    },
    { targetTokens: 1_000, transport: 'internal' },
  )
  const reservation = reserveMemoryBudgetDenial(ledger.id, denial.estimatedTokens)
  return c.json(
    reservation.responseAllowed ? denial.data : { budgetExhausted: true, memoryOutputSuppressed: true },
    200,
  )
}

app.use(
  '*',
  bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body is too large' }, 413) }),
)

app.get('/scopes', (c) => {
  try {
    const workspaceId = c.req.query('workspaceId')
    return c.json(
      listMemoryScopes({
        ...(workspaceId ? { workspaceId } : {}),
        cursor: parseCursor(c.req.query('cursor')),
        limit: parseLimit(c.req.query('limit')),
      }),
    )
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/entries', (c) => {
  try {
    const scopeId = c.req.query('scopeId')
    const workspaceId = c.req.query('workspaceId')
    if (Boolean(scopeId) === Boolean(workspaceId)) throw new TypeError('Specify exactly one scopeId or workspaceId')
    const query = c.req.query('query')
    if (query !== undefined && (!query.trim() || query.length > 200)) throw new TypeError('Invalid search query')
    return c.json(
      listMemories({
        ...(scopeId ? { scopeId } : { workspaceId }),
        cursor: parseCursor(c.req.query('cursor')),
        limit: parseLimit(c.req.query('limit')),
        ...(query !== undefined ? { query } : {}),
      }),
    )
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/entries', async (c) => {
  try {
    const value = await readJson(c)
    const scopeId = requiredString(value.scopeId, 'scopeId')
    const input = parseEntry(value)
    const created = createMemory({ scopeId, ...(input as Required<typeof input>), actor: human })
    return c.json(created, 201)
  } catch (error) {
    return handleError(c, error)
  }
})

app.patch('/entries/:entryId', async (c) => {
  try {
    const value = await readJson(c)
    const updated = updateMemory({
      scopeId: requiredString(value.scopeId, 'scopeId'),
      entryId: requiredString(c.req.param('entryId'), 'entryId'),
      expectedRevision: requiredRevision(value.expectedRevision),
      ...parseEntry(value, true),
      actor: human,
    })
    return c.json(updated)
  } catch (error) {
    return handleError(c, error)
  }
})

app.delete('/entries/:entryId', async (c) => {
  try {
    const value = await readJson(c)
    deleteMemory({
      scopeId: requiredString(value.scopeId, 'scopeId'),
      entryId: requiredString(c.req.param('entryId'), 'entryId'),
      expectedRevision: requiredRevision(value.expectedRevision),
      actor: human,
    })
    return c.body(null, 204)
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/entries/:entryId/promote', async (c) => {
  try {
    const value = await readJson(c)
    const promoted = promoteMemory({
      sourceScopeId: requiredString(value.sourceScopeId, 'sourceScopeId'),
      entryId: requiredString(c.req.param('entryId'), 'entryId'),
      targetScopeId: requiredString(value.targetScopeId, 'targetScopeId'),
      actor: human,
    })
    return c.json(promoted, 201)
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/proposals', (c) => {
  try {
    const scopeId = requiredString(c.req.query('scopeId'), 'scopeId')
    return c.json({ items: listMemoryProposals(scopeId) })
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/proposals/:proposalId/approve', (c) => {
  try {
    return c.json(approveMemoryProposal(requiredString(c.req.param('proposalId'), 'proposalId'), human))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/proposals/:proposalId/reject', (c) => {
  try {
    rejectMemoryProposal(requiredString(c.req.param('proposalId'), 'proposalId'), human)
    return c.body(null, 204)
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/scopes/:scopeId/clear-preview', (c) => {
  try {
    return c.json(previewMemoryClear(requiredString(c.req.param('scopeId'), 'scopeId'), human))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/scopes/:scopeId/clear', async (c) => {
  try {
    const value = await readJson(c)
    return c.json(
      clearMemoryScope({
        scopeId: requiredString(c.req.param('scopeId'), 'scopeId'),
        expectedRevision: requiredRevision(value.expectedRevision, 'preview revision', 0),
        actor: human,
      }),
    )
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/operations', (c) => {
  try {
    const workspaceId = c.req.query('workspaceId')
    const cursor = parseCursor(c.req.query('afterCursor'))
    const limit = parseLimit(c.req.query('limit'))
    if (workspaceId && !c.req.query('scopeId')) {
      return c.json(listWorkspaceMemoryOperations(requiredString(workspaceId, 'workspaceId'), { cursor, limit }))
    }
    return c.json(
      listMemoryOperations({
        scopeId: requiredString(c.req.query('scopeId'), 'scopeId'),
        ...(workspaceId ? { workspaceId: requiredString(workspaceId, 'workspaceId') } : {}),
        cursor,
        limit,
      }),
    )
  } catch (error) {
    return handleError(c, error)
  }
})

app.get('/workspaces/:workspaceId/view', (c) => {
  try {
    const workspaceId = requiredString(c.req.param('workspaceId'), 'workspaceId')
    const scopePage = listMemoryScopes({ workspaceId })
    const scopes = scopePage.items
    const entries = listMemories({ workspaceId })
    const proposals = scopes.flatMap((scope) => listMemoryProposals(scope.id))
    // Context persistence is populated by the session-injection phase. Returning an
    // honest empty collection is preferable to inventing delivery history here.
    const sessionId = c.req.query('sessionId')
    return c.json({
      scopes,
      entries: entries.items,
      entriesNextCursor: entries.nextCursor,
      entriesTotalCount: entries.totalCount,
      proposals,
      contexts: sessionId ? listMemoryContextRecords(workspaceId, sessionId) : [],
      ...(sessionId ? { sessionId } : {}),
    })
  } catch (error) {
    return handleError(c, error)
  }
})

/** Workspace MCP capability boundary. Provenance and scope are derived server-side. */
app.post('/agent/:toolName', async (c) => {
  const token = c.req.header('X-Kobo-Memory-Session')
  const capability = getMemoryCapability(token)
  if (!capability) return c.json({ error: 'Invalid or expired memory capability' }, 401)
  const toolName = c.req.param('toolName')
  if (!isMemoryToolName(toolName)) return c.json({ error: 'Unknown memory tool' }, 404)
  const controlReply = toolName === 'remember' || toolName === 'list_memory_scopes'

  try {
    const input = await readJson(c)
    // Stop may revoke the launch while the request body is still arriving.
    // No asynchronous work follows this check before service mutations.
    if (getMemoryCapability(token) !== capability) return c.json({ error: 'Invalid or expired memory capability' }, 401)
    const args = validateMemoryToolArguments(toolName, input)
    const actor = {
      kind: 'internal-agent',
      workspaceId: capability.workspaceId,
      sessionId: capability.sessionId,
      engine: capability.engine,
    } as const
    // Capability-only fields are never forwarded as memory arguments.
    const scopeId = typeof args.scope_id === 'string' ? args.scope_id : undefined
    if (toolName === 'list_memory_scopes') {
      const page = listMemoryScopes({
        workspaceId: capability.workspaceId,
        actor,
        ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      })
      return c.json(
        prepareMemoryControlReply(
          {
            ...page,
            items: page.items.map(({ id, level, generation, revision }) => ({ id, level, generation, revision })),
          },
          'internal',
          Number(args.cursor ?? 0),
        ),
      )
    }
    if (toolName === 'list_memories') {
      const page = listMemories({
        ...(scopeId ? { scopeId } : { workspaceId: capability.workspaceId }),
        actor,
        ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      })
      const ledgerId = getInternalMemoryBudgetContext(capability.conversationKey).id
      const freshDeliveries: Array<{ entryId: string; revision: number; kind: 'metadata' }> = []
      const items = page.items.map((entry) => {
        const delivery = { entryId: entry.id, revision: entry.revision, kind: 'metadata' as const }
        if (wasMemoryFragmentDelivered(ledgerId, delivery))
          return { id: entry.id, revision: entry.revision, alreadyDelivered: true }
        freshDeliveries.push(delivery)
        return {
          id: entry.id,
          scopeId: entry.scopeId,
          key: entry.key,
          title: entry.title,
          revision: entry.revision,
          actor: entry.actor,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }
      })
      return boundedAgentReply(c, capability, { ...page, items }, 200, freshDeliveries, Number(args.cursor ?? 0))
    }
    if (toolName === 'read_memory') {
      const entry = readMemory({ scopeId: scopeId!, entryId: args.entry_id as string, actor })
      const cursor = args.cursor as string | undefined
      const offset = cursor ? Number(cursor.split('.')[1]) : 0
      const delivery = {
        entryId: entry.id,
        revision: entry.revision,
        kind: 'body-fragment' as const,
        start: offset,
        end: offset + 40,
      }
      const fragment = sliceMemoryBodyFragment({
        body: entry.body,
        revision: entry.revision,
        ...(cursor ? { cursor } : {}),
        alreadyDelivered: wasMemoryFragmentDelivered(
          getInternalMemoryBudgetContext(capability.conversationKey).id,
          delivery,
        ),
        repeat: args.repeat === true,
      })
      return boundedAgentReply(
        c,
        capability,
        {
          entry: {
            id: entry.id,
            key: entry.key,
            title: entry.title,
            revision: entry.revision,
            ...(fragment.text !== undefined ? { body: fragment.text } : {}),
            offset: fragment.offset,
            totalCodePoints: fragment.totalCodePoints,
            truncated: fragment.truncated,
            ...(fragment.nextCursor ? { nextCursor: fragment.nextCursor } : {}),
            ...(fragment.alreadyDelivered ? { alreadyDelivered: true } : {}),
          },
        },
        200,
        fragment.text !== undefined ? [{ ...delivery, end: offset + [...fragment.text].length }] : [],
      )
    }
    if (toolName === 'search_memories') {
      const page = searchMemories({
        scopeId: scopeId!,
        query: args.query as string,
        actor,
        ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      })
      const ledgerId = getInternalMemoryBudgetContext(capability.conversationKey).id
      const freshDeliveries: Array<{ entryId: string; revision: number; kind: 'metadata' }> = []
      const items = page.items.map((entry) => {
        const delivery = { entryId: entry.id, revision: entry.revision, kind: 'metadata' as const }
        if (wasMemoryFragmentDelivered(ledgerId, delivery))
          return { id: entry.id, revision: entry.revision, alreadyDelivered: true }
        freshDeliveries.push(delivery)
        return {
          id: entry.id,
          scopeId: entry.scopeId,
          key: entry.key,
          title: entry.title,
          revision: entry.revision,
          actor: entry.actor,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }
      })
      return boundedAgentReply(c, capability, { ...page, items }, 200, freshDeliveries, Number(args.cursor ?? 0))
    }
    if (toolName === 'list_memory_operations') {
      return boundedAgentReply(
        c,
        capability,
        listMemoryOperations({
          scopeId: scopeId!,
          workspaceId: capability.workspaceId,
          actor,
          ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        }),
      )
    }

    if (capability.readOnly)
      return c.json(prepareMemoryControlReply({ error: 'This agent launch is read-only for memory' }, 'internal'), 403)
    const result = remember({
      scopeId: scopeId!,
      expectedGeneration: args.expected_generation as number,
      key: args.key as string,
      title: args.title as string,
      body: args.body as string,
      ...(typeof args.entry_id === 'string' ? { targetEntryId: args.entry_id } : {}),
      ...(typeof args.expected_revision === 'number' ? { expectedRevision: args.expected_revision } : {}),
      actor,
    })
    const receipt =
      result.status === 'applied'
        ? {
            status: result.status,
            entry: {
              id: result.entry.id,
              scopeId: result.entry.scopeId,
              key: result.entry.key,
              revision: result.entry.revision,
              updatedAt: result.entry.updatedAt,
            },
          }
        : result.status === 'proposed'
          ? {
              status: result.status,
              proposal: {
                id: result.proposal.id,
                scopeId: result.proposal.scopeId,
                generation: result.proposal.generation,
              },
            }
          : { status: result.status, reason: result.reason }
    return c.json(prepareMemoryControlReply(receipt, 'internal'))
  } catch (error) {
    const status =
      error instanceof MemoryNotFoundError
        ? 404
        : error instanceof MemoryConflictError
          ? 409
          : error instanceof TypeError
            ? 400
            : 500
    const message = error instanceof Error ? error.message : String(error)
    if (controlReply) return c.json(prepareMemoryControlReply({ error: message }, 'internal'), status)
    return boundedAgentReply(c, capability, { error: message }, status)
  }
})

export default app
