import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { getPackageVersion } from '../utils/paths.js'

/** A to-do item extracted from a Notion page. */
export interface NotionTodo {
  title: string
  checked: boolean
}

/** Structured content extracted from a Notion page (title, goal, todos, Gherkin features). */
export interface NotionPageContent {
  title: string
  goal: string
  todos: NotionTodo[]
  gherkinFeatures: string[]
}

interface JsonRpcResponse {
  jsonrpc: string
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// Gherkin keywords (French and English)
const GHERKIN_PATTERN =
  /^(Scénario|Étant donné|Quand|Alors|Scenario|Given|When|Then|Feature|Fonctionnalité|And|Et|But|Mais)/i

const nextRpcId = (() => {
  let counter = 1
  return () => counter++
})()

/**
 * Parse a Notion URL and extract the page_id in UUID format (with dashes).
 * Handles:
 *   https://www.notion.so/workspace/Title-<32hexChars>
 *   https://www.notion.so/workspace/<32hexChars>
 *   https://www.notion.so/<32hexChars>
 */
export function parseNotionUrl(url: string): string {
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

  const raw = match[1]
  // Convert 32 hex chars to UUID format: 8-4-4-4-12
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** Send a JSON-RPC request to the MCP process and read the response (30s timeout). */
export async function callMcpTool(mcpProcess: ChildProcess, toolName: string, args: object): Promise<unknown> {
  const id = nextRpcId()
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  })

  return new Promise((resolve, reject) => {
    if (!mcpProcess.stdin || !mcpProcess.stdout) {
      reject(new Error('MCP process stdin/stdout not available'))
      return
    }

    let buffer = ''

    const timeout = setTimeout(() => {
      mcpProcess.stdout?.removeListener('data', onData)
      mcpProcess.stdout?.removeListener('error', onError)
      mcpProcess.kill()
      reject(new Error(`callMcpTool('${toolName}') timed out after 30s`))
    }, 30_000)

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()

      // Try to parse complete JSON lines
      const lines = buffer.split('\n')
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse
          if (parsed.id === id) {
            clearTimeout(timeout)
            mcpProcess.stdout?.removeListener('data', onData)
            mcpProcess.stdout?.removeListener('error', onError)

            if (parsed.error) {
              reject(new Error(`MCP tool '${toolName}' error: ${parsed.error.message} (code: ${parsed.error.code})`))
            } else {
              resolve(parsed.result)
            }
          }
        } catch {
          // Ignore JSON parse errors for partial lines
        }
      }
    }

    const onError = (err: Error) => {
      clearTimeout(timeout)
      mcpProcess.stdout?.removeListener('data', onData)
      reject(err)
    }

    mcpProcess.stdout.on('data', onData)
    mcpProcess.stdout.once('error', onError)

    mcpProcess.stdin.write(`${request}\n`)
  })
}

/**
 * Read the Notion token from Claude Code's config file as a fallback.
 */
function readNotionTokenFromClaudeConfig(): string {
  try {
    const homedir = process.env.HOME ?? process.env.USERPROFILE ?? ''
    const configPath = `${homedir}/.claude.json`
    const raw = readFileSync(configPath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    const mcpServers = config.mcpServers as Record<string, { env?: Record<string, string> }> | undefined
    const notionServer = mcpServers?.notion
    return notionServer?.env?.NOTION_TOKEN ?? notionServer?.env?.NOTION_API_TOKEN ?? ''
  } catch {
    return ''
  }
}

function spawnMcpProcess(): ChildProcess {
  const notionToken = process.env.NOTION_API_TOKEN ?? process.env.NOTION_TOKEN ?? readNotionTokenFromClaudeConfig()

  const mcpCommand = process.env.NOTION_MCP_COMMAND ?? 'npx'
  const mcpArgs = process.env.NOTION_MCP_ARGS
    ? process.env.NOTION_MCP_ARGS.split(' ')
    : ['-y', '@notionhq/notion-mcp-server']

  const mcpProcess = spawn(mcpCommand, mcpArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${notionToken}`,
        'Notion-Version': '2022-06-28',
      }),
    },
  })

  mcpProcess.stderr?.on('data', (data: Buffer) => {
    // Silently consume stderr to avoid cluttering logs
    const text = data.toString()
    if (process.env.DEBUG_NOTION_MCP) {
      console.error('[notion-mcp stderr]', text)
    }
  })

  return mcpProcess
}

/** Initialize the MCP server by sending an initialize handshake (10s timeout). */
async function initializeMcp(mcpProcess: ChildProcess): Promise<void> {
  const id = nextRpcId()
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kobo', version: getPackageVersion() },
    },
  })

  await new Promise<void>((resolve, reject) => {
    if (!mcpProcess.stdin || !mcpProcess.stdout) {
      reject(new Error('MCP process not ready'))
      return
    }

    let buffer = ''

    const timeout = setTimeout(() => {
      mcpProcess.stdout?.removeListener('data', onData)
      mcpProcess.kill()
      reject(new Error('initializeMcp timed out after 10s'))
    }, 10_000)

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as JsonRpcResponse
          if (parsed.id === id) {
            clearTimeout(timeout)
            mcpProcess.stdout?.removeListener('data', onData)

            const initialized = JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
            })
            mcpProcess.stdin?.write(`${initialized}\n`)

            resolve()
          }
        } catch {
          // ignore
        }
      }
    }

    const onError = (err: Error) => {
      clearTimeout(timeout)
      mcpProcess.stdout?.removeListener('data', onData)
      reject(err)
    }

    mcpProcess.stdout.on('data', onData)
    mcpProcess.stdout.once('error', onError)

    mcpProcess.stdin.write(`${request}\n`)
  })
}

/**
 * Unwrap MCP tool response.
 * MCP returns { content: [{ type: "text", text: "..." }] }
 * where text is a JSON-stringified API response.
 */
function unwrapMcpResult(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    if (Array.isArray(obj.content)) {
      const first = obj.content[0] as { type?: string; text?: string } | undefined
      if (first?.type === 'text' && first.text) {
        try {
          return JSON.parse(first.text)
        } catch {
          return first.text
        }
      }
    }
  }
  return result
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
      if (GHERKIN_PATTERN.test(text.trim())) {
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
        gherkinFeatures.push(codeText)
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

  const mcpProcess = spawnMcpProcess()

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
    if (pageResult && typeof pageResult === 'object') {
      const result = pageResult as Record<string, unknown>
      const properties = result.properties as Record<string, unknown> | undefined
      if (properties) {
        for (const prop of Object.values(properties)) {
          const propObj = prop as Record<string, unknown>
          if (propObj.type === 'title' && Array.isArray(propObj.title)) {
            title = extractTextFromRichText(propObj.title as unknown[])
            break
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

    return { title, goal, todos, gherkinFeatures }
  } finally {
    // Ensure the MCP process is terminated
    mcpProcess.stdin?.end()
    mcpProcess.kill()
  }
}
