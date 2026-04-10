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
export function updateTemplate(
  slug: string,
  updates: { description?: string; content?: string },
): Template | null {
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

function seedTemplates(): void {
  const now = new Date().toISOString()
  const seed: Template[] = [
    {
      slug: 'review-quality',
      description: 'Code quality review',
      content:
        'Review the recently modified code in {working_branch} for:\n- Logic bugs\n- Missing error handling\n- Style issues\n\nReport only high-confidence findings.',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'add-tests',
      description: 'Add unit tests following existing patterns',
      content:
        'Add unit tests for the recently modified code. Follow the existing test patterns in this project. Focus on:\n- Happy paths\n- Edge cases\n- Error handling',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'explain',
      description: 'Explain the recent changes',
      content: 'Explain what the recently modified code does in {working_branch}, focusing on the non-obvious parts.',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'refactor',
      description: 'Safe refactoring',
      content:
        'Refactor the selected code to improve readability without changing its behavior. Explain your reasoning as you go.',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'plan-tasks',
      description: 'Break work into kobo tasks',
      content:
        'Break down the work for this workspace ({workspace_name}) into concrete tasks. Use the kobo-tasks MCP tool `create_task` to register each one with a short, actionable title. Start with a high-level analysis of what needs to happen.',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'show-tasks',
      description: 'List current kobo tasks',
      content:
        'List the current tasks for this workspace using the kobo-tasks MCP tool `list_tasks`. Show their status and highlight what is still pending.',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'mark-done',
      description: 'Mark completed kobo tasks',
      content:
        'Review the work completed so far. Identify which tasks from the kobo-tasks list are now done, and mark them using the `mark_task_done` MCP tool.',
      createdAt: now,
      updatedAt: now,
    },
    {
      slug: 'sync-tasks',
      description: 'Sync kobo tasks with the codebase',
      content:
        'Compare the current state of the codebase against the kobo-tasks list. Create missing tasks with `create_task`, mark completed ones with `mark_task_done`, and delete stale ones with `delete_task`. Explain each change before making it.',
      createdAt: now,
      updatedAt: now,
    },
  ]
  writeTemplates(seed)
}
