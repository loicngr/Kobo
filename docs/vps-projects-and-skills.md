# Projects, development servers and skills on a VPS

Continue here after [installing Kōbō](./deployment-vps.md). These commands use the
VPS Compose layout and its non-root launcher. Work in the deployment directory
on the VPS unless a step explicitly says **on your PC**.

## Prepare projects as the agent user

```bash
docker compose exec kobo kobo-vps-entrypoint --exec bash
```

Inside this shell, `id -u` must be nonzero and `echo "$HOME"` must show `/root`.
The directory name preserves existing authentication and plugin paths; it does
not mean the process runs as root. A plain `docker compose exec kobo ...` still
uses the container's root bootstrap user. Use the launcher for project installs,
logins and skills so their generated files remain writable by agents.

Install what the **project** needs in the environment executing its setup
command. PHP/Composer, language-specific extensions and browser libraries are
not all supplied by Kōbō. Check the project's runtime/lockfiles for required
versions; `make` being available does not imply every Makefile command is present.

Move to the base repository and follow its instructions, for example
`npm ci --include=dev` in its frontend and `composer install` in its backend.
Configure workspace setup to repeat the necessary steps in each new worktree:
Git does not copy ignored `node_modules`, `vendor` or private environment files.
Transfer required `.env` and local configuration files securely into the base
repository on the VPS; configure the project's worktree setup to copy only the
files needed. Check their permissions with the agent UID. Do not commit secrets.

The VPS template uses `NODE_ENV=development` and `NPM_CONFIG_INCLUDE=dev` for
project subprocesses. Kōbō itself still runs its compiled server and built UI.
This avoids omitting Quasar or other devDependencies during installation. An
older Compose file's `NODE_ENV=production` can also select the project's production
configuration: fix that environment rather than copying dev config to a prod file.

Host `.bashrc` functions are not inherited by noninteractive container agents.
For a variable such as `APP_NAME` from `.env`, use the project's Makefile/config
loader or an explicit command environment. Do not source untrusted dotenv as shell.

## Authenticate private Docker images

Git/`gh` login and Docker registry login are separate. For GHCR outside GitHub
Actions, GitHub documents a PAT **classic** with `read:packages`, from an account
allowed to read the images (authorize SSO if required). The GitHub App helper
for Git is not a replacement. [GitHub registry authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic).

From a Bash shell **on the VPS**, enter the credential without putting it in history:

```bash
read -r -p 'GitHub account for images: ' registry_user
read -r -s -p 'GHCR token: ' registry_token; printf '\n'
printf '%s' "$registry_token" | docker compose exec -T kobo \
  kobo-vps-entrypoint --exec docker login ghcr.io -u "$registry_user" --password-stdin
unset registry_token
```

The registry configuration lives in the persistent home at
`/root/.docker/config.json`. Keep it private and renew expiring tokens. Git and
`gh` can continue using an App bot independently. A `401`/`403` during an image
pull is a registry permission problem, not evidence that Git login failed.

## Reach a development server from your PC

`localhost` in the browser means **your PC**, not the VPS. Kōbō's HTTPS dashboard
does not automatically proxy project applications. If the workspace publishes
port `8700` on the VPS host, run this **on your PC**:

```bash
ssh -N -L 127.0.0.1:8700:127.0.0.1:8700 \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 YOUR-SSH-HOST
```

Open `http://localhost:8700`. Keep the terminal open; Ctrl+C closes the tunnel.
Use the actual port assigned to your workspace. Add another `-L` for another
workspace or a separate API/HMR port. Adding `-f` backgrounds the tunnel; it does
not restore it after a PC restart. If choosing a different local port, also check
any API/WebSocket URLs that embed the original port.

The remote endpoint is the **VPS host**, not the Kōbō container. A server running
via `npm` inside Kōbō needs a suitable listen address and container port publication
or a deliberate proxy route. A project stack using the host Docker socket must
publish its port on that host. Prefer loopback bindings for private development
ports: the tunnel does not close existing public Docker bindings.

For permanent access from multiple devices, configure a separate authenticated
Traefik hostname, project network and API/HMR origins. Kōbō's token protects Kōbō,
not an independently exposed project application.

## Start, stop and troubleshoot workspaces

Configure the project's start/stop commands in its **Dev server** settings.
Kōbō runs them in the worktree and supplies `INSTANCE`. Stop commands also receive
`PROJECT_NAME` when instance metadata was discovered. Use the project's start
target (for example `make dev-docker`) and a scoped stop:

```bash
docker compose -p "${PROJECT_NAME:?Missing workspace Docker project}" down --remove-orphans
```

To intentionally discard that instance's Docker volumes and local images on
**every stop**, use this opt-in alternative:

```bash
docker compose -p "${PROJECT_NAME:?Missing workspace Docker project}" \
  down --remove-orphans --volumes --rmi local
```

Removed volumes lose their data. External volumes and bind-mounted directories
are not deleted: a database in `.container/data/` remains. `--rmi local` removes
service images without custom tags, not every cached layer. Match the start
command's Compose files/profiles/environment when needed. Never use daemon-wide
pruning as a workspace stop script. [Docker Compose down](https://docs.docker.com/reference/cli/docker/compose/down/).

The panel's “running” state is not application readiness. Check the project logs
and an HTTP response too. See the [dev-server contract](../CONFIGURATION.md#dev-server).

| Symptom | Check |
| --- | --- |
| `composer`, `php` or `nc` not found | Tools and PATH in the executing container; host installs do not count. |
| Missing Quasar/build CLI | DevDependencies and `NODE_ENV`/npm include settings. |
| Registry `unauthorized` | Docker login as the agent, image permissions and token expiry. |
| `502` with containers up | Frontend compilation, exited containers, backend readiness and proxy target. |
| `EMFILE`/`ENOSPC` from file watchers | Host inotify limits and process open-file limit; containers sharing a UID consume its watcher budget. |

For a **confirmed** exhausted inotify instance limit (for example 128 across
several frontends), an operator can increase it **on the VPS host**:

```bash
sysctl fs.inotify.max_user_instances fs.inotify.max_user_watches
printf 'fs.inotify.max_user_instances = 1024\n' | sudo tee /etc/sysctl.d/90-kobo-inotify.conf
sudo sysctl -p /etc/sysctl.d/90-kobo-inotify.conf
```

Choose a value appropriate to memory and existing limits; do not lower a higher
limit or assume every `EMFILE` has this cause. Restart only the affected frontend.
Kōbō does not change host sysctls automatically.

## Install Claude/Codex instructions, skills and plugins

Open the non-root container shell shown above. Install each extension for the
intended engine: an installation on the PC/VPS host is not inherited, and a Claude
plugin installation does not install its Codex counterpart. Kōbō's **skill suite**
setting chooses prompt instructions, not native package installation.

| Content | Container location / procedure |
| --- | --- |
| Global Claude instructions | `~/.claude/CLAUDE.md`; update PC paths and copy referenced rules/scripts too. |
| Claude personal skill | `~/.claude/skills/<name>/SKILL.md` plus supporting files. |
| Claude plugins/hooks | Native installer and `~/.claude/settings.json`; merge rather than overwrite existing hooks. |
| Codex personal skill | Current Codex: `~/.agents/skills/<name>/SKILL.md`; some installers use `~/.codex/skills`. Verify with the bundled runtime. |
| Codex instructions/plugins | `~/.codex/AGENTS.md`, `~/.codex/config.toml` and the extension's documented Codex installer. |

For a reviewed Claude plugin, substitute its documented marketplace/plugin IDs
and run **inside the container shell**:

```bash
claude plugin marketplace add OWNER/REPOSITORY
claude plugin install PLUGIN@MARKETPLACE --scope user
claude plugin list
```

For a standalone skill, copy the complete directory, including scripts/assets,
to the engine's personal skill directory. A `SKILL.md` alone is insufficient if
it depends on files or an MCP server. Symlink targets must exist inside the
container and persist too. Codex plugin support varies by version: check
`codex --help` and the extension's Codex instructions rather than reusing Claude's
commands. Review hook trust/permissions separately; copying files does not grant
approval. References: [Claude skills](https://code.claude.com/docs/en/skills),
[Claude plugins](https://code.claude.com/docs/en/discover-plugins),
[Codex skills](https://developers.openai.com/codex/skills/).

Install each extension's executable dependencies too (Node/Bun/Python tools,
browsers and OS libraries). The VPS launcher includes `~/.local/bin` and
`~/.bun/bin` on PATH. Interactive shell aliases alone are insufficient.

Verify installation at both levels:

1. Check provider registration (`claude plugin list`), skill files and the
   extension's MCP/CLI diagnostics as the agent user, without printing keys.
2. Start a **new Kōbō session** with that engine and inspect its discovered
   skills/available tools. Successful CLI installation alone is not SDK discovery.
3. If something is missing, check logs, project trust and hook permissions.
   Kōbō enables Claude's user/project/local setting sources; native policies still apply.

The globally installed CLIs may differ from Kōbō's bundled Claude SDK/Codex
subprocess. A plugin accepted by a newer global Codex may not load in the bundled
runtime. Update Kōbō or use the extension's supported standalone skill installation;
do not blindly enable all hooks. Repository skills live in worktrees; personal
skills and instructions live in the home volume. Copy only relevant personal/team
rules, never all private PC configuration into a project repository.

## Switch engine accounts inside the container

Kōbō integrates the optional [ccswap CLI](https://github.com/errhythm/ccswap) in
its usage popover for **Claude Code and Codex**. Install it in the container,
not on the VPS host or your PC. Open the same non-root environment as the agents:

```bash
cd /opt/stacks/kobo
docker compose exec kobo kobo-vps-entrypoint --exec bash
```

Inside that shell, check `id -u`, `echo "$HOME"` and `command -v ccswap`.
The standard launcher keeps `/root` as HOME and adds `/root/.local/bin` to PATH.
With `uv` available, install a user-local CLI and register each login:

```bash
uv tool install ccswap
# Log in with Claude Code, then save this login (repeat for each account):
ccswap add
# Log in with `codex login`, then save this login (repeat for each account):
ccswap codex add
ccswap list --provider claude
ccswap codex list
```

Use the same `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and XDG settings as the server if
you customize these paths; authentication-directory overrides must be absolute and nonempty. Shell aliases are not executable commands. Installing
as container root can leave credential files unwritable by the agent UID; use
the launcher for every login and account-management command. Do not mount the
host's entire home just to share accounts.

In the workspace, open the usage/account popover, choose an account and click
**Switch account**. Missing ccswap hides account controls entirely. The selected
session determines which provider's accounts are offered. The switch affects
**all workspaces using that provider's credential store**, not only the open one.
Existing processes are not restarted automatically; stop and resume a session if
it retains the previous login. Skills, instructions and Kōbō history are unchanged.
See [account switching behavior](../CONFIGURATION.md#switch-claude-code-and-codex-accounts-with-ccswap).

With the default Linux layout, user-local tools and ccswap's account store
(`~/.local/share/claude-swap`) persist in the `/root` volume, alongside the engine
login directories. Preserve custom external paths separately. The updater's
Kōbō-only backup does **not** include these logins or ccswap backups. Account
stores contain secrets: do not put them in Git, image layers or diagnostic output.

## What survives kobo-update

| Location | Container restart | Container replacement |
| --- | --- | --- |
| `/root/.config/kobo`: Kōbō database, settings and application data | Preserved | Preserved and included in `kobo.tar.gz` |
| Rest of the named `/root` volume: engine logins, skills/plugins, user-local tools and downloads | Preserved | Preserved; not included in updater backup |
| Mounted projects/worktrees and project data | Preserved | Preserved; back up separately |
| Container OS packages, `/usr/local/bin` installs, global npm tools | Preserved | Replaced by the new image |
| VPS host settings, including inotify | Preserved | Unchanged; managed separately |

Browser downloads may survive in the home while their OS libraries disappear.
Put project-specific system dependencies in a reproducible derived image or an
explicit operator restoration script. The stock updater rebuilds a release plus
its standard tools layer: it does **not** preserve arbitrary custom image layers
or automatically run local restoration scripts. For a custom image, use
`kobo-update --prepare`, derive and smoke-test the prepared image, and deploy it
manually in maintenance with the documented backup/health checks. Do not put
credentials in Docker build arguments or layers.

Do not remove the home volume or copy auth files, plugin caches and private team
documents into Kōbō's Git repository. Never use `docker compose down -v` on the
Kōbō stack to clean up a project's development environment.
