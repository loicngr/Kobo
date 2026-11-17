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
cookie (Secure behind HTTPS proxies), or opt into a 30-day remembered session.
The operator token is never persisted in browser storage. Clients obtain
60-second single-use tickets for each WebSocket path. Rotation, disabling network
access, or changing proxy mode revokes sessions, pending tickets and active sockets,
including terminals. Restarting Kōbō expires ordinary sessions and upgrade tickets;
remembered sessions survive through a SQLite record containing only a session-token
hash, absolute expiry and authentication-policy fingerprint. Logout deletes that
record; rotation or policy revocation deletes all remembered sessions. Remembered
sessions do not renew their 30-day expiry automatically. WebSockets reconnect at
least every 12 hours using the still-valid browser session. A settings change may
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
capabilities. The global `agentWorkspaceLifecycleEnabled` switch (off by default)
additionally withholds workspace create, delete, archive, unarchive, purge and
restore from the managed MCP given to agents Kōbō launches, in every permission
mode. It does not cover external MCP credentials: an agent also loads the MCP
servers declared in the operator's own engine configuration (for Claude Code the
user, project and local settings; Codex and Mistral Vibe run under the same OS
account and home directory without isolation from their native configuration, so
treat them the same way), so an external Kōbō MCP server declared there with a credential granting
lifecycle tools stays callable by that agent in any permission mode. Do not declare
such a credential in the configuration of the OS account that runs the agents, or
restrict it to read-only tools. This tool boundary does not sandbox arbitrary code
executed by an agent or other integrations running as the same OS account; an agent
able to run shell commands can also reach the local operator API.

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

## Update from the interface

The optional **Update Kōbō** button (VPS Docker deployments, see
[Update from the interface](./docs/deployment-vps.md#update-from-the-interface))
adds a request channel from the operator API to a host updater. The trust boundary:

- **New capability.** An agent able to run shell commands in the container can already
  reach the loopback operator API, so it can now make the host updater build an image,
  stop and replace the container, which it could not do before. It cannot choose what
  is deployed (always the latest stable release). Without host options, a request can
  only start a backed-up update, and only when Kōbō is idle: the updater refuses a busy
  Kōbō as a command-line run does. Skipping the backup and stopping agents each need an
  explicit host-side opt-in on the unit (`--allow-skip-backup`, `--allow-stop-agents`
  in its `ExecStart`, both off by default), which the updater enforces whatever Kōbō
  answers. With stopping allowed, after Kōbō confirmed the agent stops, the updater
  re-checks inside the container that no agent session is still recorded as running
  before it stops the container. That check runs inside the container and is only as
  trustworthy as the container: it protects against a forged or mistaken `200` from
  `stop-agents`, not against a compromised container.
- **Which script enforces this.** The host options, and their enforcement on the host,
  exist only in the updater script of the version that introduced them or later.
  Updating Kōbō does not replace the host's `bin/kobo-update`; a host still running the
  2.1.46 script obeys whatever Kōbō hands it and accepts no option on its unit. Kōbō of
  this version hands such a script neither option: a request is handed out with its
  options masked by those of the poll that takes it, and that script's poll advertises
  none. In that state the protection rests on the backend, not on the host. Replace the
  operator scripts and reinstall the trigger to get the host-side guarantees (see the
  [VPS guide](./docs/deployment-vps.md#install-the-trigger-once-with-sudo)).
- **Host privileges.** The updater runs as the stack owner, who needs Docker
  access and is therefore root-equivalent on the host. Treat an update request as an
  operator action.
- **What the request carries.** Only two booleans (back up, stop agents): no version,
  command or path. From the poll reply the host accepts nothing except a string request
  id and those two booleans (each honoured only when exactly `true`, and by an updater
  of this version only when the matching host option allows it), echoes the id
  back in its status reports, and executes nothing taken from the reply. From the
  `stop-agents` reply it reads `reserved` and `unconfirmed`: the container is stopped
  only when `reserved` is `true` and `unconfirmed` is the integer `0`; any other reply
  refuses the update.
- **How the host reaches Kōbō.** Only through `docker exec` into the container. The
  in-container snippet reads the network token from `settings.json` in the Kōbō home,
  as the existing update-maintenance calls already do; nothing else from the data
  directory is read or written to exchange requests or reports. Nothing runs as root
  except the one-time unit installation. (The update itself still archives and
  migrates the data directory, exactly as a manual `kobo-update` does.)
- **The script the timer runs.** The timer runs it every minute as the stack owner, so
  the installer refuses a script or script directory not owned by root or the stack
  owner, or writable by group or others, and so is any directory above them up to `/`
  (a sticky world-writable directory such as `/tmp` included). Never mount the deployment directory or its `bin/` into the container, and
  keep it outside `KOBO_PROJECTS_DIR`, which `docker-compose.vps.yml` bind-mounts.
  With the guided installer, agents run by default under the same numeric uid as the
  stack owner: `KOBO_UID` defaults to the installing user, who also creates and owns
  the deployment directory. The protection is therefore that the deployment directory
  and its `bin/` are not mounted in the container: `docker-compose.vps.yml` mounts only
  the `kobo-home` volume and `KOBO_PROJECTS_DIR` (by default `<stack>/projects`, a
  subdirectory that does not expose its parent), and the optional GitHub App helpers
  are single files mounted read-only. An added mount of the deployment directory would
  let an agent rewrite what the timer executes. With the opt-in Docker socket the
  trigger adds nothing an agent could not already do.
- **`sudo` install.** Running the installer with `sudo` executes a file owned by the
  stack owner as root. Install only a script you trust.
- **Availability signal.** The button appears while anything has polled
  `GET /api/maintenance/update-trigger/poll` within 180 seconds. That is an ordinary
  operator route: anything able to call the operator API, an agent with shell access
  included, can make the button appear and can take a pending request. The poll also
  carries the host options (`skipBackup` and `stopAgents` query parameters, `1` meaning
  allowed, absent meaning not allowed), and the backend trusts the last poll: a spoofed
  poll can advertise options the host did not allow, or hide allowed ones. That changes
  what the dialog offers and what the backend accepts, but a request accepted that way
  is handed to the real updater with its options masked by the real updater's own poll,
  and an updater of this version also applies its own options.
- **Impersonating the updater.** The same caller can play the updater: `poll` with
  `stopAgents=1`, then `POST /api/maintenance/update-trigger` with `stopAgents: true`,
  `poll` again with `stopAgents=1` to take that request with the option kept (a poll
  without it masks the option, and `stop-agents` then answers 409), then
  `stop-agents`. Kōbō performs that stop itself
  without involving the host, so the host options do not prevent it: it stops every
  agent with no update at all and
  holds an update-maintenance reservation, so no agent can start, until its owner
  releases it or Kōbō restarts; the reservation does not expire. The marginal power is
  small: the operator API already lets such a caller stop agents. Because the real
  updater polls only between updates, a poll also forgets an unfinished status: a
  spoofed poll during a real update makes the page lose track of it, can make its
  `stop-agents` call be refused (which refuses the update before the container is
  stopped) and lets a new request be queued, which the updater's lock keeps from
  running before the current update ends. A forged `report`
  changes what the page shows and can make the real updater's `stop-agents` call or
  reports be refused (a refused `stop-agents` refuses that update before the container
  is stopped); it cannot start an update, stop the container or change what is
  deployed.
- Request and status are held in memory by the backend and carry only fixed phases and
  reasons, never free text, log lines or credentials. They are not exposed to MCP.

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

## Slack integration

The optional Slack integration uses Socket Mode, so Kōbō opens an outbound connection and needs no public URL. The bot token and app-level token are plaintext local secrets stored under the `slack` key of `KOBO_HOME/integrations.json` (mode 0600), never in `settings.json` or settings exports, and the API returns only a configured/connected status.

The allow-list of Slack member IDs (`slackAllowedUserIds`) is an operator-level grant. An empty list allows nobody and other users are ignored silently, but a listed user drives the agent with the permission mode of the linked workspace, including Bypass. List only people you would trust with a terminal on the host.

Earlier thread messages stored as context are untrusted background and are marked as such when an agent reads them with `slack_read_thread`. The Slack tools are managed and workspace-bound, are not exposed to external MCP clients, and posting is refused in restricted review and handoff launches. Agent posts neutralise `@channel`, `@here` and `@everyone`. When a workspace's question mirror setting allows it, an allow-listed Slack user can answer that workspace agent's blocking question from Slack; approvals of permission requests and secret values always stay in Kōbō.

An agent allowed to post to Slack can also send files of its own worktree to the linked channel; paths are confined to the worktree, including through symlinks, and the file content is never logged.

File downloads are restricted to HTTPS Slack hosts, with every redirect re-validated so the bearer token is never sent elsewhere. Tokens, raw Slack errors and Slack file URLs are not written to logs, HTTP responses, chat events or tool results. Messages sent while Kōbō is offline are lost, not replayed. Run one Kōbō instance per Slack app. See [CONFIGURATION.md](./CONFIGURATION.md#slack-integration).

## Development checks

CI scans Git history with a pinned Gitleaks version and runs dependency audits.
The one historical allowlisted finding is a synthetic test fixture, identified by
its exact fingerprint in `.gitleaksignore`. A successful scan is not proof that all
private information has been removed. Historical screenshots, media, author
metadata, old npm packages and GitHub artifacts need separate review.
