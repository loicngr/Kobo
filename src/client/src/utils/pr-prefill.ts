/**
 * Mirrors `WORKSPACE_NAME_MAX_LENGTH` / `truncateWorkspaceName` in
 * `src/server/utils/workspace-name.ts`: the server rejects longer names, so a
 * PR title poured into the name field must be capped the same way. The limit
 * is locked by `__tests__/pr-prefill.test.ts` ("truncates a long PR title").
 */
const WORKSPACE_NAME_MAX_LENGTH = 200

function truncateWorkspaceName(name: string): string {
  if (name.length <= WORKSPACE_NAME_MAX_LENGTH) return name
  // The server counts UTF-16 units (`.length`), so the budget is 199 units,
  // not 199 code points; only drop a high surrogate left alone at the cut so
  // an emoji straddling it disappears whole instead of as half a character.
  let head = name.slice(0, WORKSPACE_NAME_MAX_LENGTH - 1)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return `${head}…`
}

export interface PrPrefillSource {
  number: number
  title: string
  url: string
  body?: string
}

export interface PrPrefillFields {
  name: string
  description: string
}

type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * Prefill the create form from an imported PR. Anything the user typed wins:
 * only empty fields are filled. A field still holding exactly what a previous
 * import wrote (`previous`) counts as empty too, so importing another PR after
 * unlocking replaces the stale value while keeping any edit made since.
 */
export function prefillFromPr(
  pr: PrPrefillSource,
  current: PrPrefillFields,
  t: Translate,
  previous?: PrPrefillFields,
): PrPrefillFields {
  const isEmpty = (value: string, prefilled: string | undefined) => !value.trim() || value === prefilled
  const name = isEmpty(current.name, previous?.name) ? truncateWorkspaceName(pr.title) : current.name
  let description = current.description
  if (isEmpty(description, previous?.description)) {
    description = t('createPage.prResumeIntro', { number: pr.number, title: pr.title, url: pr.url })
    const body = pr.body?.trim() ?? ''
    if (body) description += `\n\n${body}`
  }
  return { name, description }
}
