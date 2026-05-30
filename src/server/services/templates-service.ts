import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getTemplatesPath } from '../utils/paths.js'

/** A single user prompt template. Stored without the leading "/" in slug. */
export interface Template {
  slug: string
  description: string
  content: string
  createdAt: string
  updatedAt: string
}

interface TemplatesFile {
  version: number
  templates: Template[]
}

const CURRENT_FILE_VERSION = 1
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_CONTENT_LENGTH = 4096
const MAX_DESCRIPTION_LENGTH = 120

/**
 * Read the templates list from disk. Seeds with defaults if the file does
 * not exist yet. Returns an empty array (with a logged error) on corruption.
 */
export function listTemplates(): Template[] {
  const filePath = getTemplatesPath()
  if (!existsSync(filePath)) {
    seedTemplates()
  }
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as TemplatesFile
    if (parsed.version !== CURRENT_FILE_VERSION) {
      console.warn(
        `[templates-service] templates.json has version ${parsed.version}, expected ${CURRENT_FILE_VERSION}. Reading best-effort.`,
      )
    }
    return Array.isArray(parsed.templates) ? parsed.templates : []
  } catch (err) {
    console.error('[templates-service] Failed to read templates.json:', err)
    return []
  }
}

/** Create a new template. Throws on invalid input or duplicate slug. */
export function createTemplate(input: { slug: string; description: string; content: string }): Template {
  validateTemplateInput(input)
  const templates = listTemplates()
  if (templates.some((t) => t.slug === input.slug)) {
    throw new Error(`Template '${input.slug}' already exists`)
  }
  const now = new Date().toISOString()
  const template: Template = {
    slug: input.slug,
    description: input.description,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  }
  writeTemplates([...templates, template])
  return template
}

/** Update an existing template. Returns null if slug not found. */
export function updateTemplate(slug: string, updates: { description?: string; content?: string }): Template | null {
  const templates = listTemplates()
  const idx = templates.findIndex((t) => t.slug === slug)
  if (idx < 0) return null
  const current = templates[idx]
  const next: Template = {
    ...current,
    description: updates.description ?? current.description,
    content: updates.content ?? current.content,
    updatedAt: new Date().toISOString(),
  }
  validateTemplateInput({ slug: next.slug, description: next.description, content: next.content })
  templates[idx] = next
  writeTemplates(templates)
  return next
}

/** Delete a template. Returns true if deleted, false if not found. */
export function deleteTemplate(slug: string): boolean {
  const templates = listTemplates()
  const next = templates.filter((t) => t.slug !== slug)
  if (next.length === templates.length) return false
  writeTemplates(next)
  return true
}

// ── Internals ──────────────────────────────────────────────────────────────

function validateTemplateInput(input: { slug: string; description: string; content: string }): void {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      `Invalid slug '${input.slug}': must match ${SLUG_PATTERN} (lowercase letters, digits, hyphens; 1–64 chars)`,
    )
  }
  // Consistent rule for both description and content:
  //  - reject if empty after trim (all-whitespace is not valid)
  //  - reject if raw length exceeds the max (trailing whitespace still counts)
  const rawDescription = input.description ?? ''
  if (rawDescription.trim().length === 0 || rawDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Invalid description: must be 1..${MAX_DESCRIPTION_LENGTH} chars`)
  }
  const rawContent = input.content ?? ''
  if (rawContent.trim().length === 0 || rawContent.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Invalid content: must be 1..${MAX_CONTENT_LENGTH} chars`)
  }
}

function writeTemplates(templates: Template[]): void {
  const filePath = getTemplatesPath()
  mkdirSync(path.dirname(filePath), { recursive: true })
  const file: TemplatesFile = { version: CURRENT_FILE_VERSION, templates }
  writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8')
}

/**
 * Replace the entire templates list atomically. Validates each entry and
 * rejects the whole write on any invalid row — do not partially accept.
 * Used by config import.
 */
export function replaceAllTemplates(templates: unknown[]): void {
  if (!Array.isArray(templates)) {
    throw new Error('Invalid templates payload: expected an array')
  }
  const now = new Date().toISOString()
  const validated: Template[] = []
  const seenSlugs = new Set<string>()
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i] as Record<string, unknown> | null
    if (!t || typeof t !== 'object') {
      throw new Error(`Invalid template at index ${i}: not an object`)
    }
    const slug = typeof t.slug === 'string' ? t.slug : ''
    const description = typeof t.description === 'string' ? t.description : ''
    const content = typeof t.content === 'string' ? t.content : ''
    validateTemplateInput({ slug, description, content })
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate template slug: '${slug}'`)
    }
    seenSlugs.add(slug)
    const createdAt = typeof t.createdAt === 'string' ? t.createdAt : now
    const updatedAt = typeof t.updatedAt === 'string' ? t.updatedAt : now
    validated.push({ slug, description, content, createdAt, updatedAt })
  }
  writeTemplates(validated)
}

export interface DefaultTemplate {
  slug: string
  description: string
  content: string
}

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    slug: 'kobo-context',
    description: "Onboard the agent on Kōbō's core concepts and tools",
    content:
      `You are working inside a Kōbō workspace (workspace "{workspace_name}", branch \`{working_branch}\`).\n\n` +
      `# What Kōbō is\n` +
      `Kōbō orchestrates multiple coding agents in parallel. Each "workspace" is a self-contained mission with:\n` +
      `- An isolated git worktree (your current working directory)\n` +
      `- A dedicated branch (\`{working_branch}\`), targeting a source branch\n` +
      `- Its own session history and task list, persisted in Kōbō's SQLite DB\n` +
      `- A dedicated MCP server (\`kobo-tasks\`) exposing tools to read/write workspace state\n\n` +
      `# Lifecycle\n` +
      `1. **Brainstorming** — you scope the work, output a plan, end with the literal marker \`[BRAINSTORM_COMPLETE]\`\n` +
      `2. **Executing** — you implement the plan, commit, push\n` +
      `3. **Auto-loop (opt-in)** — Kōbō re-spawns a fresh session per task; each iteration sees a clean context\n` +
      `4. **Completed / Archived** — the workspace freezes; the worktree stays available read-only\n\n` +
      `# Kōbō MCP tools (always namespaced \`kobo__…\`)\n` +
      `- \`kobo__list_tasks\` / \`create_task\` / \`update_task\` / \`mark_task_done\` / \`delete_task\` — manage the visible task list\n` +
      `- \`kobo__set_workspace_agent_description\` — short one-line summary shown in the sidebar; keep it current\n` +
      `- \`kobo__get_workspace_info\` / \`kobo__get_git_info\` — read workspace metadata + git state\n` +
      `- \`kobo__cron_create\` / \`cron_delete\` / \`cron_list\` — schedule recurring or one-shot triggers on THIS workspace\n` +
      `- \`kobo__mark_auto_loop_ready\` — flip the loop into auto-execution after grooming\n\n` +
      `# Conventions\n` +
      `- \`CLAUDE.md\` / \`AGENTS.md\` at the project root override default behavior — read them first\n` +
      `- \`.ai/.git-conventions.md\` (when present) defines per-project commit / branch rules — apply them on every git op\n` +
      `- \`.ai/thoughts/\` is your persistent scratch (Notion imports, Sentry context, planning notes) — write freely\n` +
      `- Never use \`--no-verify\` or skip CI hooks unless explicitly asked\n` +
      `- Always target \`origin/<source_branch>\` for diffs and PRs, not the local branch\n\n` +
      `# Boundaries\n` +
      `- The user owns the \`description\` field of the workspace — never write it; you only own \`agent_description\`\n` +
      `- The user can interrupt you at any time via the chat; treat their messages as authoritative redirections\n` +
      `- Auto-loop is automatically disabled if the user sends a chat message during a loop — they'll re-enable it manually after\n`,
  },
  {
    slug: 'review-quality',
    description: 'Code quality review',
    content:
      'Review the recently modified code in {working_branch} for:\n- Logic bugs\n- Missing error handling\n- Style issues\n\nReport only high-confidence findings.',
  },
  {
    slug: 'add-tests',
    description: 'Add unit tests following existing patterns',
    content:
      'Add unit tests for the recently modified code. Follow the existing test patterns in this project. Focus on:\n- Happy paths\n- Edge cases\n- Error handling',
  },
  {
    slug: 'explain',
    description: 'Explain the recent changes',
    content: 'Explain what the recently modified code does in {working_branch}, focusing on the non-obvious parts.',
  },
  {
    slug: 'refactor',
    description: 'Safe refactoring',
    content:
      'Refactor the selected code to improve readability without changing its behavior. Explain your reasoning as you go.',
  },
  {
    slug: 'plan-tasks',
    description: 'Break work into kobo tasks',
    content:
      'Break down the work for this workspace ({workspace_name}) into concrete tasks. Use the kobo-tasks MCP tool `create_task` to register each one with a short, actionable title. Start with a high-level analysis of what needs to happen.',
  },
  {
    slug: 'show-tasks',
    description: 'List current kobo tasks',
    content:
      'List the current tasks for this workspace using the kobo-tasks MCP tool `list_tasks`. Show their status and highlight what is still pending.',
  },
  {
    slug: 'mark-done',
    description: 'Mark completed kobo tasks',
    content:
      'Review the work completed so far. Identify which tasks from the kobo-tasks list are now done, and mark them using the `mark_task_done` MCP tool.',
  },
  {
    slug: 'sync-tasks',
    description: 'Sync kobo tasks with the codebase',
    content:
      'Compare the current state of the codebase against the kobo-tasks list. Create missing tasks with `create_task`, mark completed ones with `mark_task_done`, and delete stale ones with `delete_task`. Explain each change before making it.',
  },
  {
    slug: 'pr-review-comments',
    description: 'List PR review comments requesting changes',
    content:
      'Check if a pull request exists for branch {working_branch}.\n\nIf a PR exists (PR {pr_url}):\n1. Use the GitHub MCP tools to fetch the PR reviews and comments\n2. Filter for reviews with status "CHANGES_REQUESTED"\n3. List each review comment with:\n   - The reviewer name\n   - The file and line referenced\n   - The comment body\n   - Whether it has been resolved\n4. Summarize the outstanding requested changes that still need to be addressed\n\nIf no PR exists, say so and suggest pushing the branch first.',
  },
  {
    slug: 'ci-status',
    description: 'Check GitHub Actions status on PR',
    content:
      'Check the CI/CD status for the pull request on branch {working_branch}.\n\nIf a PR exists (PR {pr_url}):\n1. Use the GitHub MCP tools to list the check runs / status checks on the latest commit of the PR\n2. For each check, report:\n   - Check name\n   - Status (queued, in_progress, completed)\n   - Conclusion (success, failure, neutral, skipped, etc.)\n   - Duration if available\n3. If any checks failed, fetch the logs or annotations and summarize what went wrong\n4. Give an overall summary: all green, some failing, or still running\n\nIf no PR exists, say so and suggest creating one first.',
  },
] as const

function seedTemplates(): void {
  const now = new Date().toISOString()
  const seed: Template[] = DEFAULT_TEMPLATES.map((t) => ({ ...t, createdAt: now, updatedAt: now }))
  writeTemplates(seed)
}

export function reloadDefaultTemplates(): { added: string[]; kept: string[] } {
  const existing = listTemplates()
  const existingBySlug = new Map(existing.map((t) => [t.slug, t]))
  const now = new Date().toISOString()
  const added: string[] = []
  const kept: string[] = []
  const next: Template[] = [...existing]
  for (const def of DEFAULT_TEMPLATES) {
    if (existingBySlug.has(def.slug)) {
      kept.push(def.slug)
      continue
    }
    next.push({ ...def, createdAt: now, updatedAt: now })
    added.push(def.slug)
  }
  if (added.length > 0) writeTemplates(next)
  return { added, kept }
}
