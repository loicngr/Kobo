import type { ChildProcess } from 'node:child_process'
import {
  callMcpTool,
  initializeMcp,
  readClaudeMcpEntry,
  spawnMcpProcess,
  unwrapMcpResult,
} from '../utils/mcp-client.js'
import { getGlobalSettings } from './settings-service.js'

/** A to-do item extracted from a Notion page. */
export interface NotionTodo {
  title: string
  checked: boolean
}

/** Structured content extracted from a Notion page (title, goal, todos, Gherkin features). */
export interface NotionPageContent {
  title: string
  ticketId: string
  status: string
  goal: string
  todos: NotionTodo[]
  gherkinFeatures: string[]
}

// Gherkin keywords (French and English)
const GHERKIN_PATTERN =
  /^(Scénario|Étant donné|Quand|Alors|Scenario|Given|When|Then|Feature|Fonctionnalité|And|Et|But|Mais)/i

// Keywords that start a NEW scenario and must flush the current block.
// NOTE: `Feature`/`Fonctionnalité` are top-level containers, not a new scenario,
// so they stay attached to the first scenario rather than triggering a split.
const SCENARIO_START_PATTERN = /^(Scénario|Scenario)/i

function formatAsUuid(raw32Hex: string): string {
  return `${raw32Hex.slice(0, 8)}-${raw32Hex.slice(8, 12)}-${raw32Hex.slice(12, 16)}-${raw32Hex.slice(16, 20)}-${raw32Hex.slice(20)}`
}

/**
 * Parse a Notion URL and extract the page_id in UUID format (with dashes).
 * Handles:
 *   https://www.notion.so/workspace/Title-<32hexChars>
 *   https://www.notion.so/workspace/<32hexChars>
 *   https://www.notion.so/<32hexChars>
 *   https://www.notion.so/workspace/<parentId>?p=<32hexChars>&pm=s   (side-peek)
 *   https://www.notion.so/workspace/<dbId>?v=<viewId>&p=<32hexChars>  (database peek)
 *
 * When the URL embeds `?p=<32hex>` the path component is the parent / database
 * ID and the actual page being viewed is in the query parameter — that takes
 * precedence over the path.
 */
export function parseNotionUrl(url: string): string {
  // Side-peek / database pages embed the real page ID in `?p=<32hex>`.
  const pParamMatch = url.match(/[?&]p=([0-9a-f]{32})(?:[&#]|$)/i)
  if (pParamMatch) {
    return formatAsUuid(pParamMatch[1])
  }

  // Strip query string and fragment
  const cleanUrl = url.split('?')[0].split('#')[0]

  // The page ID is always the last 32 hex characters (no dashes) at the end of the path
  const match = cleanUrl.match(/([0-9a-f]{32})$/i)
  if (!match) {
    // Try to find a UUID with dashes
    const uuidMatch = cleanUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    if (uuidMatch) {
      return uuidMatch[1]
    }
    throw new Error(`Could not extract page ID from Notion URL: ${url}`)
  }

  return formatAsUuid(match[1])
}

/**
 * Read the Notion token from the user's Claude Code config as a fallback.
 * Picks the first enabled `mcpServers` entry named `notion` (disabled entries
 * are skipped). Returns an empty string when none is found.
 */
function readNotionMcpEntryFromClaudeConfig(preferredKey?: string) {
  const normalizedPreferred = preferredKey?.trim()
  const match = normalizedPreferred
    ? readClaudeMcpEntry((k) => k === normalizedPreferred)
    : readClaudeMcpEntry((k) => k === 'notion')
  if (!match) {
    if (normalizedPreferred) {
      throw new Error(
        `Notion MCP key '${normalizedPreferred}' not found or disabled in ~/.claude.json (mcpServers section)`,
      )
    }
    return null
  }
  return match
}

export function buildNotionMcpConfig(preferredKey?: string): {
  command: string
  args: string[]
  env: Record<string, string>
} {
  const configEntry = readNotionMcpEntryFromClaudeConfig(preferredKey)
  const configEnv = configEntry?.entry.env ?? {}
  const notionToken =
    process.env.NOTION_API_TOKEN ??
    process.env.NOTION_TOKEN ??
    configEnv.NOTION_TOKEN ??
    configEnv.NOTION_API_TOKEN ??
    ''

  const command = process.env.NOTION_MCP_COMMAND ?? configEntry?.entry.command ?? 'npx'
  const args = process.env.NOTION_MCP_ARGS
    ? process.env.NOTION_MCP_ARGS.split(' ')
    : (configEntry?.entry.args ?? ['-y', '@notionhq/notion-mcp-server'])

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...configEnv,
  }
  if (!env.OPENAPI_MCP_HEADERS && notionToken) {
    env.OPENAPI_MCP_HEADERS = JSON.stringify({
      Authorization: `Bearer ${notionToken}`,
      'Notion-Version': '2022-06-28',
    })
  }

  return { command, args, env }
}

function spawnNotionMcp(preferredKey?: string): ChildProcess {
  const { command, args, env } = buildNotionMcpConfig(preferredKey)
  return spawnMcpProcess(command, args, env)
}

function extractTextFromRichText(richText: unknown[]): string {
  if (!Array.isArray(richText)) return ''
  return richText
    .map((rt: unknown) => {
      if (rt && typeof rt === 'object' && 'plain_text' in rt) {
        return (rt as { plain_text: string }).plain_text
      }
      return ''
    })
    .join('')
}

interface NotionBlock {
  type: string
  id?: string
  [key: string]: unknown
}

/** Parse Notion block children into structured goal, todos, and Gherkin features. */
export function parseBlocks(blocks: NotionBlock[]): {
  goal: string
  todos: NotionTodo[]
  gherkinFeatures: string[]
} {
  const todos: NotionTodo[] = []
  const gherkinFeatures: string[] = []
  let goal = ''
  let insideObjectif = false
  let currentGherkinBlock: string[] = []

  for (const block of blocks) {
    const blockType = block.type

    if (blockType === 'heading_1' || blockType === 'heading_2' || blockType === 'heading_3') {
      // Flush current gherkin block
      if (currentGherkinBlock.length > 0) {
        gherkinFeatures.push(currentGherkinBlock.join('\n'))
        currentGherkinBlock = []
      }

      const headingData = block[blockType] as { rich_text?: unknown[] } | undefined
      const headingText = extractTextFromRichText(headingData?.rich_text ?? [])
        .toLowerCase()
        .trim()
      insideObjectif = headingText === 'objectif' || headingText === 'goal'
      continue
    }

    if (blockType === 'to_do') {
      insideObjectif = false
      const todoData = block.to_do as { rich_text?: unknown[]; checked?: boolean } | undefined
      const title = extractTextFromRichText(todoData?.rich_text ?? [])
      const checked = todoData?.checked ?? false
      todos.push({ title, checked })
      continue
    }

    if (blockType === 'paragraph' || blockType === 'bulleted_list_item' || blockType === 'numbered_list_item') {
      const data = block[blockType] as { rich_text?: unknown[] } | undefined
      const text = extractTextFromRichText(data?.rich_text ?? [])

      if (insideObjectif && blockType === 'paragraph') {
        goal = goal ? `${goal}\n${text}` : text
        continue
      }

      // Check if this is a Gherkin line
      const trimmed = text.trim()
      if (GHERKIN_PATTERN.test(trimmed)) {
        // A new "Scenario:" line starts a fresh block — flush any in-progress
        // scenario first so multiple consecutive scenarios aren't merged.
        // Only flush when the current block already contains a Scenario line
        // (a leading "Feature:" alone should stay attached to the first scenario).
        if (
          SCENARIO_START_PATTERN.test(trimmed) &&
          currentGherkinBlock.some((line) => SCENARIO_START_PATTERN.test(line.trim()))
        ) {
          gherkinFeatures.push(currentGherkinBlock.join('\n'))
          currentGherkinBlock = []
        }
        currentGherkinBlock.push(text)
      } else if (currentGherkinBlock.length > 0) {
        // Part of an ongoing gherkin block (continuation lines)
        currentGherkinBlock.push(text)
      }
      continue
    }

    if (blockType === 'code') {
      const codeData = block.code as { rich_text?: unknown[]; language?: string } | undefined
      const codeText = extractTextFromRichText(codeData?.rich_text ?? [])

      // Check if the code block contains Gherkin
      if (GHERKIN_PATTERN.test(codeText.trim())) {
        if (currentGherkinBlock.length > 0) {
          gherkinFeatures.push(currentGherkinBlock.join('\n'))
          currentGherkinBlock = []
        }
        // Split the code block on each "Scenario:"/"Scénario:" boundary so that
        // multiple scenarios in a single Notion code block become separate
        // acceptance criteria. A leading "Feature:" (if present) stays attached
        // to the first scenario.
        const sections: string[] = []
        let current: string[] = []
        for (const line of codeText.split('\n')) {
          if (SCENARIO_START_PATTERN.test(line.trim()) && current.some((l) => SCENARIO_START_PATTERN.test(l.trim()))) {
            sections.push(current.join('\n').trimEnd())
            current = []
          }
          current.push(line)
        }
        if (current.length > 0) {
          sections.push(current.join('\n').trimEnd())
        }
        for (const section of sections) {
          if (section.trim()) gherkinFeatures.push(section)
        }
      }
      insideObjectif = false
      continue
    }

    // Any other block type resets objectif context
    if (blockType !== 'paragraph') {
      insideObjectif = false
    }
  }

  // Flush remaining gherkin block
  if (currentGherkinBlock.length > 0) {
    gherkinFeatures.push(currentGherkinBlock.join('\n'))
  }

  return { goal, todos, gherkinFeatures }
}

/**
 * Extract content from a Notion page via MCP.
 */
export async function extractNotionPage(notionUrl: string): Promise<NotionPageContent> {
  const pageId = parseNotionUrl(notionUrl)
  const global = getGlobalSettings()

  const mcpProcess = spawnNotionMcp(global.notionMcpKey)

  // Give the process a moment to start
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(), 1000)
    mcpProcess.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to start MCP Notion server: ${err.message}`))
    })
  })

  try {
    // Initialize the MCP server
    await initializeMcp(mcpProcess)

    // Retrieve the page metadata (title)
    const pageRaw = await callMcpTool(mcpProcess, 'API-retrieve-a-page', { page_id: pageId })
    const pageResult = unwrapMcpResult(pageRaw)

    let title = ''
    let ticketId = ''
    let status = ''
    if (pageResult && typeof pageResult === 'object') {
      const result = pageResult as Record<string, unknown>
      const properties = result.properties as Record<string, unknown> | undefined
      if (properties) {
        for (const prop of Object.values(properties)) {
          const propObj = prop as Record<string, unknown>
          if (propObj.type === 'title' && Array.isArray(propObj.title)) {
            title = extractTextFromRichText(propObj.title as unknown[])
          }
          if (propObj.type === 'unique_id' && propObj.unique_id) {
            const uid = propObj.unique_id as Record<string, unknown>
            const prefix = (uid.prefix as string) ?? ''
            const number = uid.number as number | undefined
            if (number !== undefined) {
              ticketId = prefix ? `${prefix}-${number}` : String(number)
            }
          }
          if (propObj.type === 'status' && propObj.status) {
            const s = propObj.status as Record<string, unknown>
            status = (s.name as string) ?? ''
          }
        }
      }
    }

    // Retrieve the page blocks (content)
    const blocksRaw = await callMcpTool(mcpProcess, 'API-get-block-children', {
      block_id: pageId,
    })
    const blocksResult = unwrapMcpResult(blocksRaw)

    let blocks: NotionBlock[] = []
    if (blocksResult && typeof blocksResult === 'object') {
      const result = blocksResult as Record<string, unknown>
      if (Array.isArray(result.results)) {
        blocks = result.results as NotionBlock[]
      }
    }

    const { goal, todos, gherkinFeatures } = parseBlocks(blocks)

    return { title, ticketId, status, goal, todos, gherkinFeatures }
  } finally {
    mcpProcess.stdin?.end()
    mcpProcess.kill()
  }
}

/** Update a status property on a Notion page. Best-effort, does not throw. */
export async function updateNotionStatus(notionUrl: string, propertyName: string, statusValue: string): Promise<void> {
  const pageId = parseNotionUrl(notionUrl)
  const global = getGlobalSettings()
  const mcpProcess = spawnNotionMcp(global.notionMcpKey)

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 1000)
      mcpProcess.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`Failed to start MCP Notion server: ${err.message}`))
      })
      mcpProcess.stdout?.once('data', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    await initializeMcp(mcpProcess)

    await callMcpTool(mcpProcess, 'API-patch-page', {
      page_id: pageId,
      properties: {
        [propertyName]: {
          status: { name: statusValue },
        },
      },
    })
  } catch (err) {
    console.error('[notion] Failed to update status:', err instanceof Error ? err.message : err)
  } finally {
    mcpProcess.stdin?.end()
    mcpProcess.kill()
  }
}
