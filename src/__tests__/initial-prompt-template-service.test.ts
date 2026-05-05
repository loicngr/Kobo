import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTION_INITIAL_PROMPT,
  DEFAULT_SENTRY_INITIAL_PROMPT,
  renderNotionInitialPrompt,
  renderSentryInitialPrompt,
} from '../server/services/initial-prompt-template-service.js'

describe('renderNotionInitialPrompt', () => {
  const baseCtx = {
    ticketId: 'TK-1621',
    notionUrl: 'https://notion.so/abc',
    notionFilePath: '/wt/.ai/thoughts/TK-1621.md',
  }

  it('substitutes all three Notion variables', () => {
    const tpl = 'Read {ticket_id} at {notion_url} into {notion_file_path}.'
    expect(renderNotionInitialPrompt(tpl, baseCtx)).toBe(
      'Read TK-1621 at https://notion.so/abc into /wt/.ai/thoughts/TK-1621.md.',
    )
  })

  it('leaves unknown placeholders intact', () => {
    expect(renderNotionInitialPrompt('see {branch_name}', baseCtx)).toBe('see {branch_name}')
  })

  it('substitutes empty values without crashing', () => {
    const tpl = 'id={ticket_id} url={notion_url}'
    expect(renderNotionInitialPrompt(tpl, { ticketId: '', notionUrl: '', notionFilePath: '' })).toBe('id= url=')
  })

  it('substitutes repeated placeholders', () => {
    expect(renderNotionInitialPrompt('{ticket_id} again {ticket_id}', baseCtx)).toBe('TK-1621 again TK-1621')
  })

  it('returns empty input unchanged', () => {
    expect(renderNotionInitialPrompt('', baseCtx)).toBe('')
  })

  it('does NOT substitute double-brace {{ }} (this is the simple-brace renderer)', () => {
    expect(renderNotionInitialPrompt('{{ticket_id}}', baseCtx)).toBe('{TK-1621}')
  })
})

describe('renderSentryInitialPrompt', () => {
  const baseCtx = {
    issueId: 'ACME-API-3',
    sentryUrl: 'https://sentry.io/org/issue/123',
    sentryFilePath: '/wt/.ai/thoughts/SENTRY-ACME-API-3.md',
  }

  it('substitutes all three Sentry variables', () => {
    const tpl = 'Issue {issue_id} at {sentry_url} → {sentry_file_path}'
    expect(renderSentryInitialPrompt(tpl, baseCtx)).toBe(
      'Issue ACME-API-3 at https://sentry.io/org/issue/123 → /wt/.ai/thoughts/SENTRY-ACME-API-3.md',
    )
  })

  it('leaves unknown placeholders intact', () => {
    expect(renderSentryInitialPrompt('{ticket_id}', baseCtx)).toBe('{ticket_id}')
  })
})

describe('default constants', () => {
  it('DEFAULT_NOTION_INITIAL_PROMPT is non-empty and references at least one Notion variable', () => {
    expect(DEFAULT_NOTION_INITIAL_PROMPT.length).toBeGreaterThan(0)
    expect(DEFAULT_NOTION_INITIAL_PROMPT).toMatch(/\{(ticket_id|notion_url|notion_file_path)\}/)
  })

  it('DEFAULT_SENTRY_INITIAL_PROMPT is non-empty and references at least one Sentry variable', () => {
    expect(DEFAULT_SENTRY_INITIAL_PROMPT.length).toBeGreaterThan(0)
    expect(DEFAULT_SENTRY_INITIAL_PROMPT).toMatch(/\{(issue_id|sentry_url|sentry_file_path)\}/)
  })
})
