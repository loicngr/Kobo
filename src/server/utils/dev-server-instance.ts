import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Configuration parsed from a `.container/instances/*.env` file. */
export interface InstanceConfig {
  instanceName: string
  projectName: string
  httpPort: string
}

/**
 * Sanitize a branch name for use as a Docker instance name.
 * Replace `/` and `_` with `-`, lowercase.
 */
export function sanitizeBranchName(branch: string): string {
  return branch.toLowerCase().replace(/[/_]/g, '-')
}

/**
 * Parse a `.env` file content into key=value pairs.
 * Skips empty lines and comments (#). Handles quotes.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    result[key] = value
  }

  return result
}

/**
 * Resolve the dev-server instance config for a given project + branch.
 * Looks in `<projectPath>/.container/instances/` for `.env` files.
 */
export function resolveInstance(projectPath: string, workingBranch: string): InstanceConfig | null {
  const instancesDir = path.join(projectPath, '.container', 'instances')

  if (!existsSync(instancesDir)) return null

  const sanitized = sanitizeBranchName(workingBranch)
  const files = readdirSync(instancesDir).filter((f) => f.endsWith('.env'))

  for (const file of files) {
    const content = readFileSync(path.join(instancesDir, file), 'utf-8')
    const parsed = parseEnvFile(content)

    if (
      parsed.INSTANCE_NAME &&
      parsed.INSTANCE_NAME.toLowerCase() === sanitized &&
      parsed.PROJECT_NAME &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(parsed.PROJECT_NAME)
    ) {
      return {
        instanceName: parsed.INSTANCE_NAME,
        projectName: parsed.PROJECT_NAME,
        httpPort: parsed.HTTP_PORT ?? '',
      }
    }
  }

  return null
}
