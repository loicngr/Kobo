# Run Kōbō on your own VPS

Use this guide for a **fresh, independent, single-user instance** behind an existing
Traefik Docker provider. Your browser runs on your PC; Kōbō, its agents, Git
repositories and development processes run on the VPS. Closing the browser does
not stop the server. A shared access token does not provide separate user accounts.

Use [`docker-compose.vps.yml`](../docker-compose.vps.yml). It starts only Kōbō,
joins Traefik's existing network and persists the whole container home. It does
not import your PC's workspaces or credentials. For a stack that also installs
Traefik, see the [other Compose examples](../CONFIGURATION.md#choosing-a-compose-file).

## Guided installation

For a new deployment, use [`scripts/kobo-install`](../scripts/kobo-install) from
an up-to-date repository checkout containing the installer, deployment template and
helper scripts. The installer needs Python 3.10+, Git, local Docker with Compose,
and an existing Traefik deployment on Linux amd64. GitHub App setup also requires
Python 3.10+ and OpenSSL inside the container; the installer checks its built image.
Create an empty deployment directory writable by your SSH user, separately from
the source checkout:

```bash
sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/kobo
python3 scripts/kobo-install --directory /opt/kobo
```

The prompts collect the public domain and project directory, offer detected
Traefik settings, and let you opt into Docker socket access and GitHub App
credentials. Check the detected network, HTTPS entrypoint and certificate resolver
against your proxy configuration. Socket access remains an explicit choice because
it grants root-equivalent control over the host.

Choose an inspection or preparation mode when needed:

```bash
python3 scripts/kobo-install --directory /opt/kobo --check
python3 scripts/kobo-install --directory /opt/kobo --prepare
```

`--check` validates prerequisites and configuration without writing deployment
files, building an image or starting a container. `--prepare` writes the deployment
files and builds the image without starting Kōbō. A normal invocation completes
installation and starts the service. Both build modes require network access to
GitHub and image/package dependencies.

For unattended installation, supply the settings explicitly. Replace these
example IDs, domain, paths and proxy names with your own values:

```bash
python3 scripts/kobo-install --directory /opt/kobo --yes \
  --domain kobo.example.com \
  --projects-directory /opt/kobo/projects \
  --network web --entrypoint websecure --certresolver letsencrypt \
  --version 2.1.16 \
  --github-app-id 123456 --github-installation-id 789012 \
  --github-private-key /home/YOUR-USER/.config/github-app/app.pem
```

Omit the three `--github-*` arguments to configure forge authentication manually
later. Add `--docker-socket` only if agents need to manage project containers.
`--version` pins the release to build; the version above is illustrative. Without
it, the installer resolves the latest stable release. `--yes` skips interactive
prompts; it does not silently enable Docker socket access or overwrite a previous
installation.

This layout reserves the Compose project/router name `kobo` and volume
`kobo_kobo-home`; an existing container, router or volume using those names is
refused. Use the manual procedure if you need a second differently named instance.

For a preloaded TLS certificate, pass `--certresolver ''`; otherwise use the name
of the resolver configured in Traefik. Detection reads Traefik's Docker networks,
CLI arguments and environment, not mounted static configuration files. Confirm
the names manually when that configuration is file-based or multiple values are
detected. `--check` checks local configuration, not DNS, certificate issuance or
GitHub authentication; the normal installation checks authenticated API access
and public HTTPS after startup.

The installer places operator commands in `/opt/kobo/bin/kobo-install` and
`/opt/kobo/bin/kobo-update`. Rerun the installed installer against the same
directory to continue a prepared installation or inspect its state. It detects
changes to managed files and refuses to overwrite them. It also refuses to adopt
an older stack that was not created by this installer. Use the existing manual
procedure and updater for such deployments; do not delete their configuration to
make installation proceed.

An interrupted build can be retried with the same command; previous private build
logs remain under `install-builds/`. After a start was attempted, a retry only
finishes verification of the healthy container matching the prepared image and
Compose configuration. It never automatically recreates an uncertain container.
For example, fix DNS/certificate provisioning and rerun to finish an HTTPS check.
If the container is missing, unhealthy or changed, inspect `docker compose ps`
and its private logs first; follow the manual procedure to repair it. Interrupted
initial file writes require manual inspection of `.kobo-install.json` and the
files it lists. Do not remove persistent volumes or reset this manifest to bypass
these checks.

After installation, continue with [opening Kōbō](#2-start-and-open-kōbō) and
[authenticating agent engines](#3-authenticate-and-choose-a-project). The installer
does not log you into Claude Code, Codex or Mistral Vibe. Obtain the Kōbō browser token through the
existing startup-log command below. For installer-managed deployments, invoke the
updater as `/opt/kobo/bin/kobo-update --directory /opt/kobo`; the `./kobo-update`
examples later in this guide describe the manual installation layout.

The following numbered steps provide the **manual alternative**. Do not recreate
the source tree, Compose file or `.env` after a successful guided installation.

## 1. Prepare the host and image

Requirements: a Linux Docker host, Docker Compose v2 or later, Git, SSH access,
and an existing Traefik HTTPS entrypoint, certificate resolver and Docker network.
Point your chosen domain's DNS at that server. The updater also requires Python
3.10 or later. This recipe uses the repository image, currently built for amd64;
its `glab` installation is architecture-specific.

Create a deployment directory owned by your SSH user. `/opt/kobo` is an example;
use another absolute path if appropriate:

```bash
sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/kobo /opt/kobo/projects
cd /opt/kobo
```

Choose a published release from [GitHub releases](https://github.com/loicngr/kobo/releases).
The version below is an example, not a moving latest-version recommendation:

```bash
KOBO_VERSION=2.1.16
git clone --depth 1 --branch "v${KOBO_VERSION}" https://github.com/loicngr/kobo.git source
docker build -t kobo:local source
```

Save [`docker-compose.vps.yml`](../docker-compose.vps.yml) as `/opt/kobo/compose.yaml`
and [`scripts/kobo-update`](../scripts/kobo-update) as `/opt/kobo/kobo-update`.
Also copy [`scripts/kobo-vps-entrypoint`](../scripts/kobo-vps-entrypoint) beside the updater as `/opt/kobo/kobo-vps-entrypoint`; the updater includes it in its compatibility image layer.

These files may be newer than the example release above: obtain them from the
checkout containing this guide, not an older tag that predates them.

```bash
chmod 755 /opt/kobo/kobo-update /opt/kobo/kobo-vps-entrypoint
```

For an older release image without the launcher, build this small compatibility
layer before starting the current Compose template. Its build context contains
only the launcher, never the deployment `.env`, projects or credentials:

```bash
mkdir -p runtime
cp kobo-vps-entrypoint runtime/
docker tag kobo:local kobo:release-base
cat > runtime/Dockerfile <<'DOCKERFILE'
FROM kobo:release-base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux netcat-openbsd docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=755 kobo-vps-entrypoint /usr/local/bin/kobo-vps-entrypoint
RUN chmod a+r /app/package.json /app/package-lock.json /app/CHANGELOG.md \
    && chmod -R a+rX /app/dist /app/src/client/dist
DOCKERFILE
docker build -t kobo:local runtime
```

Create `/opt/kobo/.env` with your deployment values:

```dotenv
KOBO_DOMAIN=kobo.example.com
KOBO_PROJECTS_DIR=/opt/kobo/projects
TRAEFIK_NETWORK=web
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERTRESOLVER=letsencrypt
KOBO_UID=1000
KOBO_GID=1000
```

Replace `KOBO_UID` and `KOBO_GID` with `id -u` and `id -g` from the host user who owns your projects. Both must be nonzero. The guided installer collects them automatically; `--uid` and `--gid` override them.

The network, entrypoint and resolver names must match **your existing Traefik**;
`web`, `websecure` and `letsencrypt` are examples. If Traefik uses a preloaded
certificate rather than an ACME resolver, remove the `tls.certresolver` label.
Keep `tls: "true"`. Do not start a second proxy on the same ports. The explicit
network label selects the network Traefik uses to reach Kōbō. See
[Traefik's Docker routing reference](https://doc.traefik.io/traefik/reference/routing-configuration/other-providers/docker/).

## 2. Start and open Kōbō

From `/opt/kobo`:

```bash
docker network inspect web                    # use your TRAEFIK_NETWORK value
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180 kobo
docker compose exec kobo node -e 'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.env.KOBO_HOME + "/settings.json", "utf8")).global.networkAccessToken)'
```

Open `https://kobo.example.com/` on your PC and paste the token into the login
dialog. The retrieval command deliberately displays a secret in your local
terminal; do not copy its output into logs or shared transcripts. Startup logs
never contain the token. After upgrading from a version that logged it, rotate
the token and apply your existing log-retention policy to old copies.
`KOBO_NETWORK_ACCESS_PROXY_HOST` is populated from `KOBO_DOMAIN` and must match
the public hostname. Both network access and behind-proxy mode are enabled.
Missing or invalid proxy hostname configuration rejects public traffic. Browser
origins must match the configured scheme and port (HTTPS is the default).
The Compose example attaches HSTS and browser security headers at the TLS router;
same-origin split panes remain supported. Keep the Docker socket unmounted unless
project workflows need its root-equivalent host access.

This example publishes no HTTP or SSH ports. Use SSH to the VPS followed by
`docker compose exec kobo kobo-vps-entrypoint --exec bash` for a container shell. The VPS launcher prepares the home permissions, then drops root before starting Node. It does not start the image's optional SSH daemon. `--exec` runs administrative shell/CLI commands as the same non-root user without repeating home migration.

Check routing before starting a mission:

```bash
curl --fail https://kobo.example.com/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://kobo.example.com/api/workspaces
```

Expect health JSON with `status: "ok"` and the installed version, then `401`
without a token. `/api/health` is intentionally public. Ordinary authenticated
REST scripts use the operator token in `X-Kobo-Token`; browser login creates a
12-hour HttpOnly session cookie. External MCP clients require a dedicated key,
with explicitly granted tools/workspaces, even on loopback. See
[external MCP credentials](../CONFIGURATION.md#external-llm-access-through-mcp).
No additional Traefik route is needed for WebSocket upgrades: the browser obtains
a 60-second, single-use ticket instead of placing the operator token in the URL.

Rotating the operator token, disabling network access or changing proxy mode
revokes browser sessions and existing WebSockets, including terminal connections.
Managed agent MCP processes use a revocable per-launch capability through a
loopback-only internal endpoint, not the operator token. Plan/read-only launches
cannot mutate workspace state; only their narrow progress/report exceptions
remain. Agent processes are not stopped by browser credential revocation.

## 3. Authenticate and choose a project

### Runtime user and existing installations

The VPS Compose example runs Kōbō and its agents as `KOBO_UID:KOBO_GID`, not
root. Claude's bypass mode requires a non-root process; select that permission
mode explicitly in Kōbō. The launcher's brief root bootstrap creates a matching
user/group and assigns the dedicated home volume to them. Project directories
are never recursively chowned. They must already be writable by the chosen UID.
When the Docker socket is mounted, its numeric group is added to the agent's
supplementary groups. That access still grants control over the host daemon.

`HOME=/root` and `KOBO_HOME=/root/.config/kobo` deliberately remain unchanged:
the directory name does not mean the process runs as root. Keeping it avoids
losing existing sessions, logins, plugin paths and updater backups. Do not put
additional bind mounts below `/root` in this standalone layout.

Verify the effective identity, then use the same launcher for setup commands:

```bash
docker compose exec kobo kobo-vps-entrypoint --exec id
docker compose exec kobo kobo-vps-entrypoint --exec bash
```

A plain `docker compose exec kobo ...` still defaults to the container's root
bootstrap user. Installing skills or authenticating that way can create files
the agent cannot update. Use `kobo-vps-entrypoint --exec` throughout this guide;
reserve `--user 0` for deliberate OS maintenance. Do not add `user:` to the VPS
Compose file: that would skip the permission bootstrap of an existing root home.

For an **existing root deployment**, schedule an idle maintenance window and
back up the full home volume plus the Compose file first. Build an image with
the new launcher (the updated updater's `--prepare` does this), select your host
UID/GID in `.env`, and update the service settings below (merge the environment
with existing settings). `.env` alone does not pass variables into a container:

```yaml
entrypoint: ["kobo-vps-entrypoint"]
command: ["node", "dist/server/index.js"]
environment:
  KOBO_UID: ${KOBO_UID:-1000}
  KOBO_GID: ${KOBO_GID:-1000}
  HOME: /root
  NODE_ENV: development
  NPM_CONFIG_INCLUDE: dev
```

Keep the same named home volume and project mount paths. Recreate the idle
service, verify `id`, authenticated API access and one agent launch. The initial
ownership scan takes longer for a large home. Read-only App keys/configuration
must also be readable by the selected UID; changing the home owner cannot repair
their host permissions.

The updater preserves existing Compose settings: updating an image alone does
**not** convert a legacy `entrypoint: ["node"]` deployment to non-root. The
installer does not migrate completed managed stacks or rewrite their recorded
fingerprints. Retain their manifest as history and manage an intentional Compose
migration with the updater/manual procedure; do not rerun the installer to adopt
the altered files. The other Compose examples retain their historical entrypoint.

The current VPS template needs an image containing `kobo-vps-entrypoint`. For a
fresh manual installation of an older release, build the compatibility layer in
step 1. For an existing installation, the updated updater's `--prepare` includes
it. Do not combine the new template with an unmodified old image.

### Engine and Git login

Authenticate **inside the container**, using the engine you intend to run:

```bash
docker compose exec kobo kobo-vps-entrypoint --exec claude auth login
docker compose exec kobo kobo-vps-entrypoint --exec codex login --device-auth
```

Follow the browser URL/code printed by your installed CLI. Provider availability
and login requirements can vary; `claude auth login --help` and `codex login --help`
show the supported options. You can also configure your own provider API key.
No paid agent turn is needed for these setup commands.

For **Mistral Vibe**, install Vibe separately in the image/container and authenticate
as the same agent user. The server must be able to run `vibe-acp`. Follow
[Use Mistral Vibe inside the container](./vps-projects-and-skills.md#use-mistral-vibe-inside-the-container);
an installation or login on the host is insufficient.

For a personal GitHub account, complete the CLI's browser login flow from your PC,
then connect Git HTTPS credentials to it:

```bash
docker compose exec kobo kobo-vps-entrypoint --exec gh auth login --hostname github.com --git-protocol https --web
docker compose exec kobo kobo-vps-entrypoint --exec gh auth setup-git --hostname github.com
docker compose exec kobo kobo-vps-entrypoint --exec git config --global user.name "Your Name"
docker compose exec kobo kobo-vps-entrypoint --exec git config --global user.email "you@example.com"
```

Git commit identity and forge authentication are separate settings. For a GitHub
App bot, use the [renewable-token setup below](#github-app-bot-authentication)
instead of an interactive account login.

Clone your repository in the mounted project directory (replace the repository):

```bash
docker compose exec kobo kobo-vps-entrypoint --exec git clone https://github.com/YOUR-ORG/YOUR-REPO.git /opt/kobo/projects/my-project
```

In the first-run form, **Local project directory** means
`/opt/kobo/projects/my-project` inside the VPS container. It is neither a GitHub URL
nor a folder on the PC running the browser. Then follow [your first mission](./getting-started.md#create-a-mission).

The named `kobo-home` volume covers `/root`: it preserves Kōbō's database/settings,
Claude/Codex state, Vibe state stored under that home, and Git/forge configuration
across container replacement. A custom `VIBE_HOME` outside the volume needs its own
persistence.
Do not run `docker compose down -v`. Authentication performed only on the host is
not automatically available inside a container. See [Docker volume persistence](https://docs.docker.com/reference/compose-file/volumes/).

## Optional project Docker environments

The image includes the Docker CLI, Compose and Buildx plugins, and netcat (`nc`). Verify with
`docker compose exec kobo kobo-vps-entrypoint --exec docker compose version`; an older release image may
need these tools installed in a derived image. The updater below includes them in its compatibility layer.

To let agents manage project containers, explicitly enable the commented
`/var/run/docker.sock` mount in `compose.yaml` and recreate the service when idle.
This grants **root-equivalent control of the Docker host**, not an isolated
Docker daemon. A worktree does not provide a security boundary.

The host daemon resolves bind-mount paths on the **host**. The example therefore
mounts `/opt/kobo/projects` at the same absolute path inside Kōbō. Before creating
workspaces, set **Settings → Worktrees → worktree path** to a persistent path
under that mount, for example `/opt/kobo/projects/.worktrees`. A worktree stored
only inside `/root` cannot be used by the host daemon under that container path.
Keep the same path arrangement for any additional bind-mounted project data.

An `npm` development process does not require the Docker socket. Development
server URLs are separate from Kōbō's dashboard URL; configure their own reachable
ports or proxy routes. See the [dev-server contract](../CONFIGURATION.md#dev-server).

To keep project Docker containers running during `bin/kobo-update`, disable
**Settings → Scripts → Stop development servers when Kōbō exits** before updating.
Use detached Docker services and retain the instance configuration in the mounted
base repository so Kōbō can rediscover their status/URL after restart. Local child
processes still stop. The optional global/per-project **Kōbō shutdown** script runs
once per existing workspace worktree (including archived ones), before automatic
Docker teardown, with a 1-minute timeout. It can explicitly stop/remove containers
regardless of the toggle. See [shutdown configuration and variables](../CONFIGURATION.md#kōbō-shutdown).
The VPS example and updater allow 180 seconds for a graceful stop; keep at least
that allowance in custom supervisors for shutdown hooks to finish.

For project dependencies, private registry login, SSH tunnels, stop/cleanup commands,
file-watcher troubleshooting and installing Claude/Codex extensions, follow
[Projects, development servers and skills on a VPS](./vps-projects-and-skills.md).

## GitHub App bot authentication

A GitHub App installation token expires after one hour. Putting one token in
`.env` is insufficient for a long-running server. Supply a helper that returns
a current installation token, with renewal before expiry. GitHub documents both
[token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
and [installation authentication for HTTPS Git](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

Kōbō ships the renewal helper [`scripts/kobo-github-app-token`](../scripts/kobo-github-app-token)
and wrapper [`scripts/kobo-gh`](../scripts/kobo-gh), but no App credentials. The
installer can configure these for a new stack. To configure them manually on an
existing stack, follow the procedure below. No web-settings change is required.
This helper supports GitHub.com, not GitHub Enterprise Server.

Create your GitHub App, install it only on the repositories Kōbō should access,
and obtain its App ID (or client ID), installation ID and unencrypted RSA private
key. Grant repository **Contents: read and write** for Git pushes and **Pull
requests: read and write** for PR operations. Add other permissions only for the
operations you intend to use, such as workflow changes or CI inspection; the
helper cannot expand the App's granted permissions. See
[GitHub App permission selection](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app).
The installation ID identifies the installation, not the App or bot user.

From the source checkout, install private host files outside the repository:

```bash
install -d -m 700 /opt/kobo/auth
install -m 755 scripts/kobo-gh /opt/kobo/auth/gh
install -m 755 scripts/kobo-github-app-token /opt/kobo/auth/kobo-github-app-token
install -m 600 /path/to/YOUR-APP-PRIVATE-KEY.pem /opt/kobo/auth/app.pem
```

Create `/opt/kobo/auth/github-app.json` with the following structure, replacing
the IDs. The key path is the **container path**, not its path on the host:

```json
{
  "app_id": "123456",
  "installation_id": "789012",
  "private_key": "/run/secrets/github-app.pem"
}
```

```bash
chmod 600 /opt/kobo/auth/github-app.json
```

Add these read-only mounts under `services.kobo.volumes` in `compose.yaml`.
Create all source files first; these mounts complement the existing `/root`
volume and project bind mount:

```yaml
- type: bind
  source: /opt/kobo/auth/gh
  target: /usr/local/bin/gh
  read_only: true
  bind:
    create_host_path: false
- type: bind
  source: /opt/kobo/auth/kobo-github-app-token
  target: /usr/local/bin/kobo-github-app-token
  read_only: true
  bind:
    create_host_path: false
- type: bind
  source: /opt/kobo/auth/github-app.json
  target: /etc/kobo/github-app.json
  read_only: true
  bind:
    create_host_path: false
- type: bind
  source: /opt/kobo/auth/app.pem
  target: /run/secrets/github-app.pem
  read_only: true
  bind:
    create_host_path: false
```

The container requires Python 3.10+ and OpenSSL for this helper. Check older
images before applying the mounts; install missing dependencies in a derived
image so they survive recreation. Keep the private key outside the image and
Git repository, owner-readable only. Its host path, environment and cache are
not automatically inherited inside Docker.

The wrapper is mounted in `/usr/local/bin`, which precedes `/usr/bin` even in the
image's login shells. This covers Kōbō and agent subprocesses, whereas a shell
alias would not. It preserves all `gh` arguments and uses explicit nonempty
`GH_TOKEN` or `GITHUB_TOKEN` variables before requesting an App token. Remove
stale exported tokens when you want automatic renewal to apply.

Recreate the idle service to apply the mounts, then configure Git inside it:

```bash
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180 kobo
docker compose exec kobo kobo-vps-entrypoint --exec kobo-github-app-token --check
docker compose exec kobo kobo-vps-entrypoint --exec git config --global --replace-all credential.https://github.com.helper ''
docker compose exec kobo kobo-vps-entrypoint --exec git config --global --add credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'
docker compose exec kobo kobo-vps-entrypoint --exec bash -lc 'command -v gh'
docker compose exec kobo kobo-vps-entrypoint --exec gh repo view YOUR-ORG/YOUR-REPO --json nameWithOwner
docker compose exec kobo kobo-vps-entrypoint --exec git -C /opt/kobo/projects/my-project ls-remote origin HEAD
```

The empty helper entry resets inherited helpers **only for this HTTPS host**.
Use clean remotes such as `https://github.com/YOUR-ORG/YOUR-REPO.git`; remove any
old token embedded in a remote URL so it cannot override the helper. Normal `gh`
and Git HTTPS clone/fetch/pull/push now share the renewable credentials, within
the App's repository access and permissions. Local rebase/merge/commit operations
need no token. SSH remotes retain SSH authentication. Calling `/usr/bin/gh`
directly bypasses the wrapper.

The helper reads `/etc/kobo/github-app.json` by default. `--config PATH` selects
another JSON file; `--cache-dir PATH` selects another cache directory. In the
container it caches tokens under `/root/.cache/kobo/github-app`, retained by the
home volume. The directory is private (`0700`) and its files are private (`0600`).
It renews within two minutes of the API's actual expiry, serializes concurrent
renewals with a bounded lock, and invalidates cached tokens when the configuration
or key changes. Failed renewal never falls back to an expired token. HTTPS calls
use the fixed GitHub API endpoint and do not follow redirects.

Use `docker compose exec kobo kobo-vps-entrypoint --exec kobo-github-app-token --check` to validate signing,
GitHub authentication and the cache without exposing a token. It prints a JSON
status and expiration time. On failure, check file permissions, the key and IDs,
the App installation's repository access, server clock and outbound HTTPS. Do not
run the helper without `--check` in a shared terminal or log: its normal stdout is
the credential consumed by the wrapper.

The token authenticates remote operations; it does not choose the author of local
commits. Configure commit identity separately, for example using your App's bot
login and its actual GitHub bot-user email:

```bash
docker compose exec kobo kobo-vps-entrypoint --exec git config --global user.name 'YOUR-APP[bot]'
docker compose exec kobo kobo-vps-entrypoint --exec git config --global user.email 'BOT-USER-ID+YOUR-APP[bot]@users.noreply.github.com'
```

`BOT-USER-ID` is the bot account's user ID, not the App ID or installation ID.
The installer does not invent or overwrite a Git author identity.

For host-side Git, install/configure a host-side wrapper and credential helper too;
container settings do not change the host. Do not print token-helper output or
paste credentials into logs. This wrapper pattern is optional deployment plumbing,
not an extra authentication setting in Kōbō's UI.

## Update with kobo-update

From the deployment directory:

```bash
cd /opt/kobo
./kobo-update --check        # inspect prerequisites and latest stable release
./kobo-update                # build, back up and deploy the latest stable release
```

To select a version or build without interruption:

```bash
./kobo-update 2.1.16 --prepare  # example version; build and smoke-test only
./kobo-update 2.1.16           # deploy that version, or do nothing if already installed
```

From another directory, pass `--directory /opt/kobo`. From your PC, for example:
`ssh -t YOUR-VPS '/opt/kobo/kobo-update --directory /opt/kobo'`.
The source copy can also be invoked directly with
`python3 scripts/kobo-update --directory /opt/kobo --check`.

The updater is for this **standalone Linux Docker layout**, not every Compose
stack: one service named `kobo`, a `compose.yaml`, `KOBO_HOME=/root/.config/kobo`,
a named volume mounted at `/root`, and an HTTPS proxy hostname in the service
environment. It reads the Compose project name, hostname and volume rather than
assuming a particular server. It uses the local Docker daemon; do not point it
at a remote Docker context. It requires network access to npm, GitHub and image
build dependencies. It does not update Traefik or install a scheduled auto-updater.

Keep `kobo-vps-entrypoint` beside `kobo-update` when updating the operator scripts (the guided installer places both in `bin/`). This is required even when building an older release.

Both operator scripts explicitly read the deployment directory's `.env` for
Compose. Exported `KOBO_DOMAIN`, `KOBO_PROJECTS_DIR`, `TRAEFIK_NETWORK`,
`TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`, `KOBO_UID`, `KOBO_GID` and `COMPOSE_*` variables in the caller's
shell cannot override these commands. This applies to validation, start, stop and
recovery. Docker context selection and forge authentication remain available to
child processes; other commands such as image builds retain their environment.

The installed runtime must support the atomic update-maintenance endpoint
(`GET /api/maintenance/update`, protocol 1). Older releases, including the 2.1.16
example above, do not: automatic deployment and `--check` refuse without stopping
the service. `--prepare` remains available to build a candidate image. For the
first upgrade from such a release, explicitly stop the old service, back up its
home volume, and deploy the prepared image manually; the updater never falls
back to an unsafe check-then-stop sequence. Do not bypass this check in the script.

It checks active agents before the build. Immediately before stopping, the backend
atomically verifies inactivity and reserves admission: manual and automatic agent
starts cannot slip between the final check and shutdown. Workspace creations and
PR checkouts in progress also block reservation; new ones are refused while it
is held, before creating records, worktrees or running setup scripts. A creation
keeps its admission slot through asynchronous preparation and any rollback,
including the MCP PR-import sequence. Cron, wakeup and quota
deliveries wait without consuming their persisted instructions or deadlines.
Valid pending wakeups are marked as deferred before the reservation succeeds,
including deadlines that will fall during downtime; this prevents the normal
five-minute stale-wakeup cleanup from deleting them after a long backup. Their
original deadline and prompt stay unchanged. Already stale, never-attempted
wakeups are not revived.
It retrieves npm's `latest` version (or the explicit
stable version), verifies the Git tag's commit and package version, builds a uniquely
tagged image, ensures Compose, Buildx, netcat and the non-root launcher are installed and checks native modules. The old
service stays available during the build. Plan for roughly 5–15 minutes without
build cache; backup duration depends only on the size of Kōbō's data directory.

Once idle, it stops Kōbō, archives only `/root/.config/kobo`, tests SQLite
migrations/integrity on a copy, pins the new image directly in `compose.yaml`, and
starts the service. It checks container health, the authenticated internal API,
the version served through HTTPS, and public API rejection without a token. It
preserves other Compose settings and mounts, refuses downgrades and concurrent
updates, and detects Compose/environment edits during the build. The script
itself stays at the version you installed; copy a newer reviewed script from the
repository when you want to update the updater.

## Backups and failed updates

Each update records its private log, `state.json`, previous Compose file,
`kobo.tar.gz` and recovery instructions in `<deployment>/updates/<timestamp>-<id>/`.
The archive contains the whole `/root/.config/kobo` directory: SQLite database
and WAL/SHM sidecars when present, settings, templates, attachments and other Kōbō
data. It retains paths relative to `/root`. Settings can contain credentials;
keep the archive private. `state.json` records the backup scope and archive name.
A prepared-only build does not create a backup. No old images, backups or
volumes are automatically removed; monitor disk space and retain off-host copies.

An error before shutdown releases the reservation, including a lost acquisition
response. If shutdown was attempted, the updater confirms the old process has
stopped before restarting it. An interrupted updater can leave admission reserved;
the reservation deliberately has no expiry that could reopen the race. Follow
`RECOVERY.md` and the durable phase: before a new-version launch, stop the old
container and confirm its exit before restarting it. Restart clears the in-memory
reservation. Never release it while a Docker stop could still be in progress.

Claude Code/Codex/Mistral Vibe configuration and credentials, skills/plugins, caches, browser
downloads, repositories/worktrees, bind-mounted App keys/scripts and project
database volumes are **not included** in `kobo.tar.gz`. Files outside the Kōbō
directory remain in the existing volume; the updater neither archives nor deletes
them. Back up important files separately, along with `.env` and deployment files.
Never copy a live SQLite
file as your only database backup; the updater stops Kōbō before archiving it.

A build failure leaves the current service running. A backup or migration-test
failure restarts the previous version before new code touches production data.
After a new-version launch, an error leaves data intact for diagnosis: an older
image must not be blindly started against a migrated database, and a snapshot
restore could discard messages or work resumed since launch. Read the generated
`RECOVERY.md`: for a rollback, stop Kōbō and clone the current volume into a **new
volume** so engine credentials and skills are retained. In the new volume only,
replace `.config/kobo` completely from `kobo.tar.gz`, preserving numeric ownership
and permissions, then use that volume with the previous image. Do not overlay an
old database onto newer WAL/SHM files. Keep the original volume. This restores
Kōbō data only, not engine state or project changes.

Older updater versions created `home.tar.gz` containing all of `/root`; use each
backup's own `RECOVERY.md`. Updating the Kōbō image does not update the operator
script: install the newer `scripts/kobo-update` to use the smaller backups.
An interrupted update blocks subsequent updates until its
recorded state has been reviewed. Inspect logs locally; they may contain secrets.

For troubleshooting, start with `docker compose ps`, the private update log and
`docker compose logs --tail 100 kobo`. A Traefik 404/502 calls for checking the
shared network, hostname, resolver and container health before restoring data.
The application update banner only reports releases; it does not run this script.

## Embedded application previews

To test a workspace application from the Kōbō interface, configure the optional
[authenticated preview gateway](./dev-server-preview.md#vps-through-traefik).
It uses a dedicated wildcard HTTPS domain and a separate internal listener,
through [the preview Compose overlay](../docker-compose.preview.yml). No project
HTTP port needs to be exposed publicly for this route.

The installer does not provision preview DNS or certificates. If you use
`kobo-update`, integrate the overlay's environment and labels into the deployment's
`compose.yaml`: the updater does not load an additional preview overlay. Keep the
main Kōbō and preview Traefik services explicitly assigned to their routers.
Follow the preview guide before enabling it; project API/HMR URLs still need to
work from a remote browser.
