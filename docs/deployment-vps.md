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
12-hour HttpOnly session cookie, or a persistent 30-day session when
**Remember this device for 30 days** is checked in the login dialog. Remembered
sessions survive Kōbō updates/restarts with the same database and authentication
policy; the browser does not store the operator token. External MCP clients require a dedicated key,
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
./kobo-update --skip-backup    # deploy without the kobo.tar.gz backup (see below)
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
build dependencies. It does not update Traefik or install a scheduled auto-updater. (The optional
[interface trigger](#update-from-the-interface) installs a polling timer, but never
starts an update without a click.)

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

`--skip-backup` is an explicit opt-in for a real deployment (it is refused with
`--check` and `--prepare`) and never the default. It creates no `kobo.tar.gz`:
the updater prints a warning, records `backup_skipped: true`, a null archive name
and `backup_complete: false` in `state.json`, and writes a `RECOVERY.md` that
points to no archive. The migration test still runs: with Kōbō stopped, only
`kobo.db` and its WAL/SHM sidecars are copied into `migration-check/`, a
disposable copy that the test may migrate and that is **not** a backup. A failure
before the new version starts still restarts the previous version on the
untouched data. After a new-version launch there is no recovery point from this
update: use it only when you already hold your own current backup of
`/root/.config/kobo`.

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
The optional [interface button](#update-from-the-interface) does, through a host timer
you install yourself.

## Update from the interface

Once a host timer is installed, the changelog page can show an **Update Kōbō**
button. It runs the same `kobo-update` as above on the host, without a terminal. It
always deploys the **latest stable release**: there is no version choice, no
`--check`/`--prepare`, and no recovery from the interface. A failed update that needs
recovery is handled on the host, as described in
[Backups and failed updates](#backups-and-failed-updates).

The browser never talks to the host. Kōbō only records the request in memory. A
systemd timer on the host runs `kobo-update --serve-ui-request` every minute; the
script asks the running container (`docker exec`, using the network token inside the
container) whether a request is waiting, and runs the normal update when one is. The
request carries two booleans (back up, stop agents) and nothing else: no version,
command or path; an updater of this version or later honours them only with its own
options, and Kōbō hands an older one neither (see below). The timer only polls: it starts an update only when a request was made
through the operator API, which is what the click on the changelog page does (an
agent with shell access in the container can make the same call, see the security
notes), and nothing updates Kōbō on a schedule. See
[SECURITY.md](../SECURITY.md#update-from-the-interface).

### Install the trigger (once, with sudo)

Run it as root, naming the deployment directory. For the layout created by the
guided installer:

```bash
sudo /opt/kobo/bin/kobo-update --install-ui-trigger --directory /opt/kobo
```

For a manual layout where the script sits in the deployment directory:

```bash
sudo /opt/kobo/kobo-update --install-ui-trigger --directory /opt/kobo
```

Two host-side options decide what a request from the interface may do. Both are off
by default:

- `--allow-skip-backup` lets a request skip the backup. Without it the updater always
  backs up, whatever the request says, and the dialog offers no choice.
- `--allow-stop-agents` lets a request stop running agents. Without it a busy Kōbō
  refuses the update, as a command-line run does, and the dialog offers no stop box.

Add the ones you want to the install command, for example:

```bash
sudo /opt/kobo/bin/kobo-update --install-ui-trigger --directory /opt/kobo --allow-stop-agents
```

They are written into the service's `ExecStart`, and the updater enforces them on the
host whatever Kōbō answers. To change them, run `--install-ui-trigger` again with the
wanted options.

These options, and their enforcement on the host, exist only in the updater script of
the version that introduced them or later. Updating Kōbō never replaces the host's
`bin/kobo-update`, so a host can still run the 2.1.46 script after Kōbō itself was
updated. That script obeys whatever Kōbō hands it, and it does not know the options:
`--install-ui-trigger --allow-...` exits with status 2 (unknown option). Kōbō hands
such a script neither option: its poll advertises none, and a request taken by a poll
that does not allow an option loses that option. In that state the protection rests on
Kōbō, not on the host.

> **Upgrading from 2.1.46**
>
> Once Kōbō runs a newer version, the dialog changes even though the trigger still
> works: there is no backup checkbox (a backup is always made) and no stop-agents
> checkbox (a busy Kōbō cannot be updated from the interface). To choose these options
> again:
>
> 1. Update Kōbō, from the interface or with `kobo-update`.
> 2. Replace the operator script `kobo-update`, and `kobo-vps-entrypoint` beside it,
>    with those of the new version (see [Update with kobo-update](#update-with-kobo-update)
>    and [Prepare the host and image](#1-prepare-the-host-and-image)).
> 3. Run `--install-ui-trigger` again with the wanted options, for example
>    `sudo /opt/kobo/bin/kobo-update --install-ui-trigger --directory /opt/kobo --allow-stop-agents`.
> 4. Check the unit with `systemctl cat kobo-ui-update.service`: the options end its
>    `ExecStart` line.

The install command writes `kobo-ui-update.service` and `kobo-ui-update.timer` under
`/etc/systemd/system`, then runs `systemctl daemon-reload` and
`systemctl enable --now kobo-ui-update.timer`. The service runs the script as the
owner of the deployment directory, which must be able to run `docker` and
`docker compose`. Nothing else is installed or run as root. Remove it with:

```bash
sudo /opt/kobo/bin/kobo-update --uninstall-ui-trigger
```

The installer refuses, and writes nothing, when:

- it is not run as root;
- the host has no `systemctl` or no `/etc/systemd/system`;
- the deployment directory has no `compose.yaml`;
- the deployment directory is owned by root (the updater would run as root: use the
  deployment user), or its owner's uid has no user entry, or the owner's user name
  does not match `[A-Za-z_][A-Za-z0-9_.-]*` (optionally ending in `$`);
- the stack path or the script path contains whitespace, a quote, a backslash, `%`
  or `$`;
- the script is missing, is not owned by root or by the stack owner, or is writable
  by group or others (the timer runs the file every minute as the stack owner, so
  nobody else may be able to change it); the same two rules apply to the script's
  own directory;
- a directory above the script, up to `/`, is not owned by root or by the stack
  owner, or is writable by group or others (a world-writable directory with the
  sticky bit, such as `/tmp`, is refused too); the message names the directory. With
  the script inside the deployment directory, as in both layouts above, this means the
  deployment directory and every directory above it must not be group-writable. This
  is stricter than 2.1.46, which checked only the script and its own directory: a
  deployment or home directory in mode 775 or 770 with a private group is now refused
  (`chmod g-w` on that directory fixes it);
- the script is not executable or has no `#!` first line.

A directory above the script that cannot be read stops the install before anything is
written.

Every directory from the script up to `/` is checked, because whoever can write one
of them can replace what the timer runs. Running the install with `sudo`
executes a file owned by the stack owner as root, so install only a script you trust.

The units record the resolved absolute paths of the script and the stack. Run the
install command again if either moves, and after a recovery that recreates the home
volume or moves the stack. Running it again replaces the units in place; a failed
install restores the previous ones.

The trigger serves one stack per host: the unit names are fixed, so installing it for
a second deployment directory replaces the units of the first one.

### What happens on click

The button appears on the changelog page only when a newer release exists, the host
timer has polled Kōbō within the last 3 minutes and no other update is in progress.
It ignores the update banner's dismissed version. The update starts **within about
a minute** of the click, at the next poll. The dialog offers:

- **Back up the data before updating**, ticked by default, only when the trigger was
  installed with `--allow-skip-backup`. Unticking it is the `--skip-backup` mode
  described above: no `kobo.tar.gz`, no recovery point for that update, though the
  migration test on a database copy still runs. Otherwise the dialog says **This
  server always backs up the data before updating.**
- When Kōbō is not idle for an update, by the same rule as the updater's reservation
  (live agents, a running session, or a workspace marked as extracting, brainstorming,
  executing or compacting), the **Stop the running agents and update** box, only when
  the trigger was installed with `--allow-stop-agents`. Without that option **Update
  now** stays disabled and the dialog says **This server does not allow stopping the
  agents for an update: wait for them or stop them, then retry.** The
  dialog says **Running agents: N. Updating requires stopping them.**, or, when no
  agent runs, **A workspace is still marked as running, although no agent is
  running. Updating requires confirming the stop below.** **Update now** stays
  disabled until the box is ticked (the dialog says **Tick the box to confirm that the
  running agents may be stopped.**). Kōbō's own refusal of an update request in that
  state is the backstop, and the updater checks again before stopping if agents
  started during the build. With the box ticked, a workspace status left behind
  without an agent does not block the update.

Agents are stopped only **once the new image is built**, so the service and its
agents run normally during the build. The stop uses the same cause as a normal
shutdown, so auto-loop intent and scheduled wakeups, cron and quota retries are kept.
Kōbō first closes agent admission, then stops every agent, and proceeds only if
every stop is confirmed. Before stopping the container, the updater (of the version
that introduced the host options, or later) then checks on
its own, inside the container, that no agent session is still recorded as running,
and refuses the update otherwise (a workspace status left behind is not counted:
startup reconciliation settles it). An unconfirmed stop, a session handoff in progress, or a
workspace creation or PR checkout in flight refuses the update: Kōbō keeps running
and admission reopens.

A refusal after the stop does not undo it. Stopped manual sessions stay stopped,
with their pending questions and permission requests discarded. Auto-loop workspaces
and pending review returns restart on their own when admission reopens. A sequential
review resumed this way is told that Kōbō was restarted although it was not, because
the stop reuses the shutdown cause (known limit). A parallel
review still reviewing is marked interrupted; one that already saved its report is
recovered as ready or completed. If the old container was already stopped and the
update then aborts, the updater restarts the previous version: anything not
persisted is lost as in any restart, and the page shows **The update was aborted.
Kōbō keeps running on the previous version.**

### What the page shows

Progress appears in the dialog and under the changelog header, and survives a page
reload in the same tab (the request is remembered in `sessionStorage`). Status is only
followed while the changelog page is open. The lines are:

- **Waiting for the updater: the server starts the update within about a minute**;
- **Building the new version**;
- **Stopping the running agents** (only when you chose to stop them);
- **Restarting Kōbō**, then **Reconnecting to Kōbō** while the server is away. You
  may have to sign in again after the restart.

Results:

- **Kōbō was updated to version X.** Success is announced when the updater's final
  `complete` report arrives and the running version changed (without a changed
  version the line is **The update is complete.**). If that report never arrives, for
  example because the restart lost it, success is announced only after a 5-minute
  grace, and only when the running version changed. The grace counts from the last
  time the update was seen in progress, restarts when status requests succeed again
  after failing, and counts from the click for an update never seen in progress (for
  example when the tab stayed hidden during the whole update). A failed update whose
  final report reaches Kōbō is shown as failed, even if a newer version is running.
  A `recovery-required` report sent while the new version is not answering yet (for
  example migrations still running when the 180-second start wait ends) is sent again
  by every following timer run, so it arrives once Kōbō answers. It cannot arrive
  while Kōbō is not running at all, but the page cannot be reached then either. A
  page that announced success after the grace, before the report arrived, changes to
  the failure when the report is adopted, unless the message was closed first; the
  failed `kobo-ui-update.service` described below remains the signal on the host.
- **Kōbō is already up to date.**
- A refusal with its reason: **The update was refused: Kōbō is busy.**, **...another
  update is already running.**, **...a previous update was interrupted and needs a
  manual recovery.**, **...this installation cannot be updated from the interface.**
  or **The update was refused for an unknown reason.**
- **The update was aborted. Kōbō keeps running on the previous version.**
- **The update failed and needs a manual recovery on the host. See the update
  logs.**

Two states mean the outcome is unknown. **The update did not start, or its report
was lost. Check the host before trying again.** appears when the request was never
seen in progress and Kōbō knows nothing about it (for example no poll reached it
within 3 minutes) while the version did not change. **The update stopped reporting.
Check the server before starting another one.** appears when the status went stale,
when Kōbō has known nothing about the request for 5 minutes after it was last seen in
progress without a version change, or after 10 minutes of failing status requests.
In both cases check the host with `journalctl -u kobo-ui-update.service` and the
job's `RECOVERY.md` before retrying. While Kōbō is stopped for a long backup, the page
can show **The update stopped reporting.** and it changes to the result when the final
report is adopted, unless that message was closed first. When an update was started
from another tab or by another operator, the page shows only **An update is in
progress.**

### See what happened on the host

```bash
systemctl status kobo-ui-update.timer
journalctl -u kobo-ui-update.service
ls /opt/kobo/updates/
```

A run that gets past the prerequisite checks uses the usual job directory
`<stack>/updates/<timestamp>-<id>/` with its private log, `state.json` and
`RECOVERY.md`. A run refused by those checks (Kōbō busy, an interrupted earlier
update, the runtime check, or already up to date) creates none. A run takes the
update lock before polling: while another update holds it (for example a
command-line `kobo-update`), the run exits silently without polling, and the request
stays pending for a later run (Kōbō drops it after 3 minutes). Because the updater
polls only between updates, a poll that finds an unfinished status forgets it: an
update whose final report was lost no longer blocks a new request, and the page
treats it as unknown to Kōbō (see above). The service exits with a failure only while a job is in `recovery-required`, so
a failed `kobo-ui-update.service` means the host needs attention even when the web
interface is down. It stays failed, and prints that job's directory name each minute,
for as long as any job's `state.json` says `recovery-required`; in that state it
neither polls Kōbō nor starts an update, and re-sends the job's `recovery-required`
report when the job was started from the interface. To clear it, follow the job's `RECOVERY.md`
(see [Backups and failed updates](#backups-and-failed-updates)) and, once the service
is verified healthy, set that `state.json` phase to `complete` or `aborted`, as
`RECOVERY.md` describes. Refusals and aborted updates exit successfully and are reported to the
page instead.

If the stack owner cannot use Docker (not in the `docker` group, or the group is not
visible to the unit), each timer run exits silently: the script prints nothing in the journal and the
button never appears. Check with `sudo -u <owner> docker ps`.

### Limits

- The service runs under the stack owner's account, so Docker authentication for
  registry pulls and builds comes from that account's Docker configuration.
  Credential helpers that need a desktop keyring or login session, and rootless
  Docker, have not been tested and are not expected to work.
- Stopping the service or rebooting during an update goes through the updater's
  normal interruption and recovery path (`TimeoutStopSec=600`, `KillMode=mixed`):
  read `RECOVERY.md` as for any interrupted update.
- The running Kōbō must already include this feature and the atomic update
  reservation (`protocol: 1`); otherwise the timer stays silent or the update is
  refused with the legacy-runtime reason.
- Not validated end to end: the systemd integration and the in-container calls are
  covered by deterministic tests only (patched `systemctl` and Docker). No real
  systemd unit, Docker daemon or VPS was exercised.

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
