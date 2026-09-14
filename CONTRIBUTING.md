# Contributing to Kōbō

Thanks for considering a contribution. This guide covers the from-source setup, available scripts, testing discipline, git workflow, and release process. For architecture, data model, and code conventions, see [`AGENTS.md`](./AGENTS.md).

## Prerequisites

Node.js ≥ 24.15. The repository's `.nvmrc` pins the tested version; run
`nvm use` when using nvm.

## Setup

```bash
git clone https://github.com/loicngr/Kobo.git
cd Kobo
npm run install-all   # root + client + PWA build dependencies
npm run dev:all   # backend :3300 + client :8080
```

A production-installed Kōbō (`npx @loicngr/kobo`) and a dev server can run side by side, since they use separate data directories (`KOBO_HOME=./data` in dev vs `~/.config/kobo/` in production).

## Scripts

```bash
npm run dev            # backend only (tsx watch, :3300)
npm run dev:client     # frontend only (quasar dev, :8080)
npm run dev:all        # both concurrently

npm run build          # production build (client + server)
npm start              # run the compiled server

npm test               # backend vitest suite
npm run test:client    # client vitest suite
npm run test:all       # both

npm run lint           # biome check (lint + format)
npm run lint:fix       # biome check --write

npx tsc --noEmit       # backend type check
npm run typecheck:tests # backend tests and fixtures type check
(cd src/client && npm run type-check) # client + Vue type check

make ci                # install + audit + lint + type checks + build + both test suites
make help              # list every Makefile target
```

Run a single test file with `npx vitest run src/__tests__/<file>.test.ts`, filter by name with `-t "<pattern>"`.

## Testing discipline

TDD for backend changes: write the failing test, confirm it fails for the right reason, implement minimally, then confirm it passes. Frontend tests cover stores, utilities, composables, and selected Vue components using Vue Test Utils and `happy-dom`. Type-checking and browser smoke tests complement this coverage. See [`AGENTS.md`](./AGENTS.md#testing-discipline) for route mocking and cleanup conventions.

Backend tests pin `KOBO_HOME` to a temporary directory; never point tests at your production data. Live MCP tests are a separate, explicit command (`npm run test:mcp:live`) requiring `KOBO_LIVE_ENGINE`, `KOBO_LIVE_MODEL`, and real provider credentials. They stay outside normal CI; see the [MCP guide](./src/mcp-server/README.md#live-engine-validation).

Schema changes must append a migration and update the fresh-install schema, with upgrade tests proving data preservation. See [Database migrations](./AGENTS.md#database-migrations). UI changes must follow [`DESIGN.md`](./DESIGN.md) and update all five translation files for user-visible text.

## Git workflow

- Branch off `develop`: `feature/<slug>` or `fix/<slug>`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.
- Rebase on `develop` before opening a PR; never merge it in.
- Keep commits atomic — each one compiles and passes tests.
- Never force-push to shared branches.

Run `make ci` before pushing. It reinstalls all three dependency trees with `npm ci`, audits them, runs Biome and the three type checks, builds production assets, then runs both test suites. CI runs on pushes to `develop` and PRs targeting `develop` or `main`.

Full commit and branch conventions are in [`AGENTS.md`](./AGENTS.md#git-workflow).

## Release process

Releases are cut from `main`. Prepare the version change in a branch targeting `develop`, keeping `package.json` and its lockfile synchronized; then merge `develop` into `main`. A push to `main` starts the release workflow. Manual dispatch also requires `main`.

The workflow installs and audits dependencies, lints, type-checks the server and client, runs both test suites, and builds. Before publishing, it refuses a version or tag that already exists. It then publishes to npm with provenance, tags `v<version>`, and creates the GitHub Release. `make release` runs the local CI gates plus the version/tag availability checks; publishing remains the workflow's responsibility.
