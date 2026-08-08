# Contributing to Kōbō

Thanks for considering a contribution. This guide covers the from-source setup, available scripts, testing discipline, git workflow, and release process. For architecture, data model, and code conventions, see [`AGENTS.md`](./AGENTS.md).

## Prerequisites

Node.js ≥ 24.15.

## Setup

```bash
git clone https://github.com/loicngr/Kobo.git
cd Kobo
npm install
(cd src/client && npm install)   # or: npm run install-all
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

make ci                # full CI pipeline (audit + lint + tsc + tests)
make help              # list every Makefile target
```

Run a single test file with `npx vitest run src/__tests__/<file>.test.ts`, filter by name with `-t "<pattern>"`.

## Testing discipline

TDD for backend changes: write the failing test, confirm it fails for the right reason, implement minimally, confirm it passes, commit. See [`AGENTS.md`](./AGENTS.md#testing-discipline) for the full conventions (route test mocking, `beforeEach` cleanup, frontend store coverage).

## Git workflow

- Branch off `develop`: `feature/<slug>` or `fix/<slug>`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.
- Rebase on `develop` before opening a PR; never merge it in.
- Keep commits atomic — each one compiles and passes tests.
- Never force-push to shared branches.

Run `make ci` before pushing. CI runs lint, type check, and tests on every PR to `develop`.

Full commit and branch conventions are in [`AGENTS.md`](./AGENTS.md#git-workflow).

## Release process

Releases are cut from `main`. Bump `package.json` on `develop`, merge into `main`, push. The release workflow builds, tests, publishes to npm, tags `v<version>`, and creates the GitHub Release. It fails early if the version or tag already exists.
