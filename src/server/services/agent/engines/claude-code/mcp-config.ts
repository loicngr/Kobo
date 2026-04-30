import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerSpec } from '../types.js'

const MCP_FILENAME = '.mcp.json'

export function writeMcpConfig(workingDir: string, servers: McpServerSpec[]): string {
  const filePath = join(workingDir, MCP_FILENAME)
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {}
  for (const s of servers) {
    mcpServers[s.name] = { command: s.command, args: s.args, env: s.env }
  }
  writeFileSync(filePath, JSON.stringify({ mcpServers }, null, 2))
  return filePath
}

export function cleanupMcpConfig(workingDir: string): void {
  const filePath = join(workingDir, MCP_FILENAME)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch {
      // Best-effort cleanup
    }
  }
}
