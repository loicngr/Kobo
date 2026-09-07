export const WORKTREES_PATH = '.worktrees'

/**
 * Global settings holding a live credential. They must never leave the server
 * in a payload a third party can read: they are blanked out of the config
 * bundle, of the settings the HTTP API returns, and of what the MCP tools hand
 * to the agent. Add any new credential here rather than filtering it at one
 * call site.
 *
 * Lives in `shared` on purpose: the MCP server and the HTTP layer both need it,
 * and a test that mocks `settings-service` must not be able to mock the list of
 * secrets away.
 */
export const SECRET_GLOBAL_KEYS = ['notionMcpKey', 'sentryMcpKey', 'networkAccessToken', 'bitbucketToken'] as const

/**
 * Stand-in the API sends instead of a stored credential. A client never
 * receives the real value, so the settings form round-trips this mask on save
 * and the write path reads it as "leave the stored one alone". Typing a new
 * value still replaces the secret, and clearing the field still erases it —
 * only an untouched field is preserved.
 */
export const MASKED_SECRET = '••••••••'
