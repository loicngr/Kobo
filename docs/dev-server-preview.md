# Dev-server previews

Preview the application's running dev server inside its Kōbō workspace. This is
an interactive site, not a screenshot or an agent-controlled browser.

## Open and arrange the preview

1. Configure the project's [dev-server commands](../CONFIGURATION.md#dev-server).
2. Start the server from the workspace's **Tools → Dev server** card.
3. Once its status is **Running**, click the full-width **Preview** button. You
   can also use the layout button beside **Configure** in the workspace header.

The layout menu is shown only while the server is running:

| View | Behavior |
|---|---|
| **Chat** | The normal conversation and message input. |
| **Chat + preview** | Chat and the application side by side, separated by a draggable divider. |
| **Preview** | The application fills the central workspace area. |

The workspace list and right drawer remain independent; use their existing
header buttons and resize handles. Drag the central divider to balance chat and
preview. Double-click it, or focus it and press Home, to reset the ratio. Left
and right arrow keys adjust it. Minimum panel widths keep the controls visible.
Preferences are stored in the browser, with separate ratios for an open or closed
right drawer.

The preview toolbar provides **Reload**, **Open in a new tab** and **Close**.
The same controls work inside the two-workspace view. Switching layouts keeps
the current chat draft and does not trigger a leave-page confirmation; changing
workspace or session still uses the normal unsaved-work protection.

Closing restores the previous drawer visibility and widths without stopping the
dev server. Switching views keeps the chat mounted and preserves its draft;
closing or reloading the preview unloads the site, so unsaved forms may be lost.
When a running dev server stops, Kōbō closes the preview, returns to Chat and
hides the layout selector. Restarting the server does not reopen it automatically.

### Mobile and narrow workspaces

On mobile, or when drawers leave too little room for two panels, use **Chat** or
**Preview** one at a time. Side drawers use the existing mobile overlay behavior.
The site's own responsive layout determines how well it works at that width.

### Direct links

`/#/workspace/<workspace-id>/preview` opens the preview-only view;
`/#/workspace/<workspace-id>/preview?preview=split` requests chat alongside it
when there is enough space. These links open Kōbō's workspace UI; the application
itself loads from a separate local or authenticated remote origin.

## Local computer, without Docker

Use the existing project dev-server start/stop commands. Kōbō detects the Vite,
Next or Quasar localhost readiness URL, and the browser loads that port and
entry path directly, with the isolated hostname described below.
There is no DNS, Traefik, extra preview listener, or public exposure to configure.

The preview uses the dedicated loopback hostname `kobo-preview.localhost`,
including the new-tab button, so cookies belonging to Kōbō on `localhost` or a
loopback IP are not sent to the project's server. Modern browsers resolve
`.localhost` to loopback without public DNS. Allow this hostname in the dev
server configuration (and local HTTPS certificate if used). Use relative
application URLs: redirects or absolute requests to another local hostname are
controlled by the application, not rewritten by this direct mode.

Open Kōbō through localhost or 127.0.0.1. A remote browser must not interpret a
server-side `localhost` URL as its own computer: this is refused with a
configuration error. An HTTPS Kōbō page also cannot embed an HTTP dev server.
Use HTTPS for both or run both locally over HTTP.

## Local computer, with Docker

The browser still uses the published host port, for example
`http://kobo-preview.localhost:8720`. `KOBO_DEV_SERVER_DOCKER_HOST=host.docker.internal` only
changes the agent/server-side URL; it never becomes an iframe URL.

Publish the application's HTTP port on the host, preferably on loopback. A dev
server started *inside the Kōbō container* must listen on `0.0.0.0` in that
container and its port must be explicitly published by Compose. A server in a
sibling container similarly needs its own published port. Kōbō cannot make an
unpublished port reachable from the host browser. For Linux Docker, retain the
existing `host.docker.internal:host-gateway` mapping where necessary.

## VPS through Traefik

Enable only after setting up DNS and HTTPS:

1. Point `*.preview.kobo.example.com` at the VPS. Use a dedicated preview domain
   under the same site as Kōbō so Strict cookies work in the embedded view.
2. Configure Traefik's DNS challenge for the wildcard certificate.
3. Set `KOBO_PREVIEW_DOMAIN=preview.kobo.example.com` in the deployment `.env`.
4. Apply `docker-compose.preview.yml` together with the existing Kōbō Compose
   file. The overlay adds a separate Traefik service pointing to port 3001;
   it does not publish that port to the host. Keep the main Kōbō service on 3000.
5. Keep network access, behind-proxy mode and the public HTTPS Kōbō origin
   configured as documented in [VPS deployment](./deployment-vps.md). Sign in normally.

Copy [the preview overlay](../docker-compose.preview.yml) beside your deployment's
`compose.yaml`, set `KOBO_PREVIEW_DOMAIN` in `.env`, and validate the combined
configuration before applying it:

```bash
docker compose -f compose.yaml -f docker-compose.preview.yml config --quiet
docker compose -f compose.yaml -f docker-compose.preview.yml up -d kobo
```

These commands recreate Kōbō; stop active agents before applying deployment
changes. Use the same Compose files for subsequent manual operations.

**If you use `kobo-update`:** it explicitly loads only `compose.yaml`. Merge the
overlay's `environment` and `labels` into that file before enabling previews;
keep its existing volumes, networks, credentials and image configuration.
Validate with `docker compose -f compose.yaml config --quiet`. An overlay supplied
only to a one-off `up` command will not survive the updater's next recreation.
The guided installer does not configure preview DNS, certificates or the overlay.

### Gateway environment

| Variable | Default | Purpose |
|---|---|---|
| `KOBO_PREVIEW_DOMAIN` | Unset | Preview DNS suffix, without scheme, port or path. Enables the remote gateway. |
| `KOBO_PREVIEW_PORT` | `3001` | Gateway listener port; keep the Traefik service port aligned. |
| `KOBO_PREVIEW_BIND_HOST` | `127.0.0.1` | Native listener address. The Docker overlay uses `0.0.0.0` inside the container. |
| `KOBO_DEV_SERVER_DOCKER_HOST` | `localhost` | Host reachable from Kōbō for project Docker-published ports; the VPS Compose uses `host.docker.internal`. |

For a native Kōbō process behind Traefik, use the same domain and set
`KOBO_PREVIEW_PORT` (default 3001) and `KOBO_PREVIEW_BIND_HOST` (default
127.0.0.1) to an address reachable *only by the proxy*. Configure the equivalent
Traefik router/service to reach that listener. Never expose it as a public HTTP
port. TLS terminates at Traefik.

Unlike direct container exposure, all preview requests go through a small
Kōbō gateway after Traefik. This gives local processes and sibling Docker
containers the same authorization and WebSocket handling, without modifying
project labels or granting Kōbō write access to Traefik's configuration.
Origins use a stable lowercase hash of the exact workspace ID; case-sensitive
IDs cannot collide through DNS lowercasing. Browser input cannot choose an
upstream target. The gateway only reaches URLs resolved by the existing dev
server service on loopback or the explicitly configured Docker host.

A one-use, 60-second ticket establishes an HttpOnly, Secure, host-only preview
cookie (up to one hour, bounded by the parent session). Never put the operator
token into the preview URL. Kōbō cookies and headers are removed before forwarding
requests; the site's own authentication remains separate. Unknown hosts, absent
sessions and cross-origin writes/WebSocket upgrades are refused. Logout and
policy changes revoke new requests immediately; open WebSockets and stopped
server grants are rechecked every five seconds. Restarting Kōbō invalidates all
preview grants. Reopen/refresh the preview to authorize again.

Do not apply Kōbō's `SAMEORIGIN` framing middleware to the preview router. The
gateway permits framing only by the configured Kōbō origin and preserves other
application CSP directives. If an application's remaining CSP blocks resources,
configure that application rather than disabling its CSP wholesale.

## Application configuration

A proxy cannot repair compiled JavaScript that calls `http://localhost:8720`
from a remote browser. Configure relative API URLs, or the workspace's public
HTTPS origin. Frontend and API should share the dev server entry point. Configure
trusted hosts/proxies and HMR's public `wss://` endpoint if the framework requires
it. The gateway supports HTTP streaming and WebSocket upgrades; uploads are
bounded to 50 MiB and stalled upstream requests time out after 30 seconds.

Local sites may refuse iframes with X-Frame-Options/CSP. Use **Open in a new tab**
or allow the local Kōbō origin in the site's development configuration. An iframe
load event cannot prove the application rendered successfully, so Kōbō does not
claim that it can diagnose those browser-enforced failures.

A Git worktree does not isolate databases. Confirm each dev instance's data
source before editing records through a preview. No production data, DNS,
certificates or VPS configuration is changed by enabling the frontend views.

The gateway rewrites HTTP redirects back to the public preview origin when they
target either the declared browser URL or the internal dev-server origin. Other
origins (such as an external identity provider) are left unchanged. This does not
rewrite URLs embedded in application HTML or JavaScript.

The initial path, query string and fragment announced by the dev server are
preserved when opening a remote preview. Use relative links inside the application
so subsequent navigation stays on the preview origin.

## Troubleshooting

| Symptom | Check |
|---|---|
| Preview button or layout menu missing | The workspace server must report **Running**. Check the start command and readiness/status contract. |
| Local hostname rejected | Allow `kobo-preview.localhost` in the project's development host configuration; keep host checks enabled. |
| Connection refused with Docker | Publish the application port and bind the dev process to `0.0.0.0` inside its container. |
| Remote preview configuration error | A remote browser cannot reach the VPS through its own loopback; configure the HTTPS gateway. |
| HTTPS page blocks a local HTTP preview | Use compatible HTTP/HTTPS origins; do not disable browser mixed-content protections. |
| Blank/refused iframe | Check the application's framing policy. Use **Open in a new tab** for a local site that refuses embedding. |
| Remote preview says the link expired or returns 403 | Sign in to Kōbō, then use its preview **Reload** button to obtain a fresh ticket. Do not bookmark a ticket URL. |
| Remote assets, login or HMR fail | Check relative API URLs, trusted hosts/proxies, HTTPS cookies and the public WebSocket endpoint. |
| Preview disappears after an update | Confirm the gateway environment and Traefik labels are in the Compose file actually used by the updater. |

Local direct previews retain the browser's normal storage and cookie rules.
Applications that require third-party storage or cross-origin authentication may
need to be opened in a separate tab. See [general troubleshooting](./troubleshooting.md)
for Kōbō environment and authentication issues.
