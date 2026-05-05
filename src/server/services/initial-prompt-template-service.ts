/** Variables available for the Notion initial prompt template. */
export interface NotionInitialPromptContext {
  ticketId: string
  notionUrl: string
  notionFilePath: string
}

/** Variables available for the Sentry initial prompt template. */
export interface SentryInitialPromptContext {
  issueId: string
  sentryUrl: string
  sentryFilePath: string
}

export const DEFAULT_NOTION_INITIAL_PROMPT = `MANDATORY context-enrichment for Notion ticket {ticket_id}. Run this BEFORE any codebase exploration, sub-agent dispatch, brainstorming skill, or ExitPlanMode call.

1. Read {notion_file_path}.
2. Fetch every linked Notion resource via the Notion MCP tools: sub-tickets, references, linked blocks, linked databases. Recurse one level into anything that looks task-relevant.
3. Persist EVERYTHING you found to {notion_file_path}. Inline the sub-page content, extracted requirements, acceptance criteria, dependencies, key field values. The file becomes the single source of truth — anything not written there is invisible to the downstream agent.
   - If Edit/Write is available right now: use it immediately on {notion_file_path}, then move on.
   - If you are in plan mode and Edit/Write is blocked: the very FIRST line of your implementation plan MUST be a verbatim Edit/Write call on {notion_file_path} with the full enriched content. Not a paraphrase, not a TODO — the literal tool call with the file path and the new content. Place it BEFORE any code change in the plan.
4. After the file is written (or after ExitPlanMode if you were in plan mode), re-read {notion_file_path} to confirm.

HARD RULES:
- Do NOT call ExitPlanMode until step 2 has fetched the linked resources and you know what content step 3 will write.
- Do NOT skip step 3. "I have the context in mind" is NOT acceptable — write it to disk.
- Do NOT dispatch sub-agents to explore the codebase before {notion_file_path} is enriched (or planned to be enriched as line 1 of your plan).`

export const DEFAULT_SENTRY_INITIAL_PROMPT = `MANDATORY context-enrichment for Sentry issue {issue_id}. Run this BEFORE locating the bug, writing tests, or implementing the fix.

1. Read {sentry_file_path}.
2. Use the Sentry MCP tools to fetch the latest events, breadcrumbs, tags, runtime/environment details, related issues and any reproduction hints.
3. Persist EVERYTHING you found to {sentry_file_path}. Inline stack frames, frequent breadcrumb sequences, environment matrix, related events, hypotheses. The file becomes the single source of truth — anything not written there is invisible to the downstream fix.
   - If Edit/Write is available right now: use it immediately on {sentry_file_path}.
   - If you are in plan mode and Edit/Write is blocked: the very FIRST line of your implementation plan MUST be a verbatim Edit/Write call on {sentry_file_path} with the full enriched content. Not a paraphrase, not a TODO — the literal tool call with the file path and the new content. Place it BEFORE any code change in the plan.
4. After the file is written, re-read {sentry_file_path} to confirm.

HARD RULES:
- Do NOT skip step 3. "I have the context in mind" is NOT acceptable — write it to disk.
- Do NOT explore the codebase or write a failing test before {sentry_file_path} is enriched (or planned to be enriched as line 1 of your plan).`

function renderSimple(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]
    return match
  })
}

/** Render the Notion initial prompt by substituting {var} placeholders. Pure. */
export function renderNotionInitialPrompt(template: string, ctx: NotionInitialPromptContext): string {
  return renderSimple(template, {
    ticket_id: ctx.ticketId,
    notion_url: ctx.notionUrl,
    notion_file_path: ctx.notionFilePath,
  })
}

/** Render the Sentry initial prompt by substituting {var} placeholders. Pure. */
export function renderSentryInitialPrompt(template: string, ctx: SentryInitialPromptContext): string {
  return renderSimple(template, {
    issue_id: ctx.issueId,
    sentry_url: ctx.sentryUrl,
    sentry_file_path: ctx.sentryFilePath,
  })
}
