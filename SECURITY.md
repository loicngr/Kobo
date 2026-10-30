# Security

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/loicngr/Kobo/security/advisories/new).
Private reporting was verified enabled on 2026-09-23. Do not disclose credentials,
private conversations, customer tickets or an unpatched exploit in a public issue.
Include the Kōbō version, OS, engine, deployment mode and a minimal reproduction
using synthetic data. The maintainer handles reports on a best-effort basis; no
response-time commitment is offered. Fixes target the latest release.

## Trust boundary

Kōbō is a local, single-user development tool. Agents, terminals, project hooks and
configured MCP commands execute on the **server machine**, with the privileges of
the account running Kōbō and the selected engine's permission mode. A Git worktree
isolates a checkout, not processes, credentials or the filesystem. Only open
projects and configure executable hooks/integrations you trust.

The default listener is loopback. Network access uses an operator token; it is not
per-user authorization. Browsers exchange it for a 12-hour HttpOnly, SameSite=Strict
cookie (Secure behind HTTPS proxies), never persist it in localStorage, and obtain
60-second single-use tickets for each WebSocket path. Rotation, disabling network
access, or changing proxy mode revokes sessions, pending tickets and active sockets,
including terminals. Restarting Kōbō also expires sessions. A settings change may
establish a new session for the browser that performed it using the returned token.

Behind a reverse proxy, enable the corresponding setting and declare the exact
public origin with `KOBO_NETWORK_ACCESS_PROXY_HOST` (bare domains default to HTTPS).
Health checks are exempt. Host and Origin validation remain separate protections.
Use HTTPS or a trusted private network; do not offer this installation as a shared
public service. Configure HSTS at the HTTPS terminator. The supplied public Compose
examples include it. Socket and request size/rate/concurrency limits are bounded
in-process; proxy limits should complement them. Client IPs come from OS sockets,
so callers behind the same proxy share limits.

External MCP requires a separately issued Bearer credential, including on loopback.
Each key has explicit tool and workspace grants, optional expiry, and independent
revocation; only its hash is stored. The UI defaults to read-only tools, selected
workspaces and 30-day expiry. Operator cookies/tokens cannot authenticate `/api/mcp`,
and an MCP key cannot authenticate operator APIs or terminal upgrades. Global stdio
forwards to that endpoint using `KOBO_MCP_TOKEN`; it does not read the database offline.

Managed workspace stdio uses a per-launch `KOBO_MCP_SESSION_TOKEN` through the local
`/api/internal-mcp` dispatcher. The backend owns authorization and database writes;
Plan and read-only review launches cannot invoke mutating managed tools even if the
provider approves a tool. Launch capabilities are revoked when stopping begins.
Operational progress and narrowly scoped review/handoff reports retain their own
capabilities. This tool boundary does not sandbox arbitrary code executed by an
agent or other integrations running as the same OS account.

Git workflow preferences express which automatic actions are wanted. They are not
a sandbox for arbitrary shell commands or external MCP tools. Claude Code, Codex
and Mistral Vibe permission modes have different enforcement mechanisms; unrestricted access can
modify files outside a worktree. Provider authentication is separate from Kōbō's
network token.

Mistral Vibe uses native ACP execution modes and has no Plan/read-only mode.
Review prompts forbid modifications, but native permissions do not guarantee
filesystem read-only access. Kōbō-managed review tools and memory remain restricted
to reads, scoped reports and progress. See [Mistral Vibe](./CONFIGURATION.md#mistral-vibe).

## Embedded dev-server previews

Local previews use `kobo-preview.localhost` rather than Kōbō's own localhost/IP
hostname, so its host-only session cookie is not sent with the initial request
to the project's port. The application still controls its own requests and
redirects; direct local mode is not a general-purpose network sandbox.

The optional remote gateway uses separate workspace HTTPS origins. An
authenticated operator session issues a single-use, 60-second ticket, exchanged
for a host-only HttpOnly/Secure preview cookie. Preview access is bounded by the
operator session and expires within an hour. Kōbō cookies are filtered before
proxying to the dev server. The upstream target comes from workspace dev-server
status, not browser input, and must be loopback or the configured Docker host.
Logout and policy changes invalidate authorization; active connections and target
status are checked periodically. Keep the gateway listener reachable only through
the reverse proxy, and do not expose project ports publicly as a workaround.

The gateway adjusts framing headers to permit the configured Kōbō origin while
preserving other application CSP directives. Applications remain responsible for
their authentication, API URLs and data sources. A worktree does not isolate a
database, and the preview is not a public sharing feature. See the
[preview guide](./docs/dev-server-preview.md) for deployment and limitations.

## Data and credentials

KOBO_HOME stores conversations, workspaces, backups and settings. Direct integration
commands and credentials live in `integrations.json`, written atomically with mode
0600 on Unix. Settings and their temporary files/backups are also private (0600),
and new Kōbō home directories use 0700. They are plaintext local secrets: protect the host account and backups.
They are excluded from settings exports and are never returned by the connection
status API. A replacement connection must be entered in full. MCP error text and
stderr are withheld because third-party processes may echo secrets.

Agents send prompts and applicable project context to the selected provider.
Notion/Sentry receive requests only when their configured actions are used.
Git forge actions use your authenticated CLI/configuration. The update checker
contacts the npm registry. Local history is not a promise that agent execution is
offline. Review exports and attachments before sharing them: conversation content
and personal paths may be sensitive even when known credential fields are redacted.

## Development checks

CI scans Git history with a pinned Gitleaks version and runs dependency audits.
The one historical allowlisted finding is a synthetic test fixture, identified by
its exact fingerprint in `.gitleaksignore`. A successful scan is not proof that all
private information has been removed. Historical screenshots, media, author
metadata, old npm packages and GitHub artifacts need separate review.
