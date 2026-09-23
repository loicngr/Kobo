# Your first Kōbō workspace

Kōbō is a local, single-user application that runs Claude Code or OpenAI Codex in Git worktrees. Each user installs their own instance and supplies their own provider account. A shared network token is not a multi-user account system.

## Requirements

- Node.js 24.15 or later, Git and Bash, with a writable local Git repository containing at least one commit.
- A working login or API credential for the engine you choose. Kōbō ships neither credentials nor a provider subscription. Provider usage can incur charges.
- Linux is the locally exercised platform for this readiness change. CI is configured to exercise Linux and macOS; a configured job is not a completed compatibility test. Windows users need a Linux environment such as WSL; native Windows and WSL have not been validated in this release rehearsal.

No skill plugin, forge CLI, Docker, Notion, Sentry or voice software is needed for a basic mission. A repository without a remote works; choose forge `none` to disable PR/MR features.

## Start

```bash
npx @loicngr/kobo@latest
```

This installs the latest published version, which may precede changes on `develop`. To try an unreleased checkout, follow [Contributing](../CONTRIBUTING.md), run `npm run build`, and start with a disposable home:

```bash
KOBO_HOME="/tmp/kobo-first-run" npm start
```

Open <http://localhost:3000>. The server binds to loopback by default. Do not expose it to a network just to complete setup.

## Create a mission

1. In the first-run panel, choose an engine and the path of your local Git repository.
2. Run **Check environment**. Resolve missing Git, Bash, runtime, or write access before continuing. Authentication and model availability remain **unverified**: diagnostics do not contact a paid model or read your credentials.
3. Continue to the creation form. Name the mission and describe a small change, including its acceptance criteria.
4. Keep **Standard** and **Plan** for the first review. Standard requires no external skill suite. Plan does not silently become unrestricted when you prepare or enable auto-loop.
5. Review the plan, explicitly select an execution permission mode when you are ready, and send the implementation instruction. Review the resulting diff before committing or publishing.

New installations use manual commit, push and PR/MR publication preferences, disable audio and optional ticket integrations, and admit at most two concurrent unattended starts. Manual sessions can exceed that threshold. Agent workflow preferences are instructions; the engine permission mode supplies the actual sandbox and approval behavior.

You can skip setup and reopen it from **Help → First-run setup**. Setup checks do not start a mission automatically.

## Optional features

Configure integrations only when you need them, in their Settings tabs. Notion and Sentry support direct command, JSON arguments and JSON environment configuration without a Claude installation; credentials are stored locally outside settings exports. Connection tests run only when explicitly requested. Forge actions use your authenticated forge CLI or configured Bitbucket credentials. See [Configuration](../CONFIGURATION.md) and [Security](../SECURITY.md).

## Existing installations

Upgrades preserve customized prompts, plugin selection, integration toggles, permission modes and resource limits. Existing installations retain legacy automatic Git workflow preferences; review them in Settings if you prefer manual authorization. Existing workspaces receive a snapshot of that historical policy, while new workspaces snapshot the effective global/project/create policy. Changing a global policy does not rewrite existing missions.

Known shipped prompt text and retired sound selections are migrated; custom prompt text is preserved. Audio enablement and volume are retained. Take a complete backup before an upgrade; see [Troubleshooting](./troubleshooting.md).
