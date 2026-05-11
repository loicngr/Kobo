# Kōbō — Makefile
#
# Mirrors `.github/workflows/ci.yml` and `release.yml` so the full CI pipeline
# can be reproduced locally before pushing. Targets stop on the first failing
# step (set -e via the recipe shell).
#
# Quick reference:
#   make ci          # everything CI runs on a PR (audit + lint + tsc + tests)
#   make release     # CI gates + build + version-not-yet-published guard
#   make test        # backend + client tests only
#   make lint        # biome lint only
#   make audit       # npm audit on both trees
#   make install     # `npm ci` on both trees (CI-equivalent install)
#   make build       # production build (client + server)
#   make clean       # rm dist/

# Resolve bash via PATH (NixOS doesn't ship /bin/bash; Ubuntu CI does).
SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

CLIENT_DIR := src/client
PACKAGE_NAME := @loicngr/kobo

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "Kōbō — local CI/release runner"
	@echo ""
	@echo "Targets:"
	@echo "  make ci         Run the full PR pipeline (install + audit + lint + tsc + tests)"
	@echo "  make release    Run CI + build + verify version is not already published"
	@echo "  make install    npm ci on both trees"
	@echo "  make audit      npm audit --audit-level=high on both trees"
	@echo "  make lint       biome check"
	@echo "  make typecheck  tsc --noEmit (backend)"
	@echo "  make test       backend + client vitest suites"
	@echo "  make test-back  backend tests only"
	@echo "  make test-front client tests only"
	@echo "  make build      production build"
	@echo "  make clean      remove build artefacts"

# ── Install ────────────────────────────────────────────────────────────────────

.PHONY: install install-root install-client
install: install-root install-client

install-root:
	npm ci

install-client:
	cd $(CLIENT_DIR) && npm ci

# ── Audit (mirrors CI `--audit-level=high`) ────────────────────────────────────

.PHONY: audit audit-root audit-client
audit: audit-root audit-client

audit-root:
	npm audit --audit-level=high

audit-client:
	cd $(CLIENT_DIR) && npm audit --audit-level=high

# ── Lint / typecheck ───────────────────────────────────────────────────────────

.PHONY: lint typecheck
lint:
	npm run lint

typecheck:
	npx tsc --noEmit

# ── Tests ──────────────────────────────────────────────────────────────────────

.PHONY: test test-back test-front
test: test-back test-front

test-back:
	npm test

test-front:
	cd $(CLIENT_DIR) && npm test

# ── Build ──────────────────────────────────────────────────────────────────────

.PHONY: build clean
build:
	npm run build

clean:
	rm -rf dist
	rm -rf $(CLIENT_DIR)/dist

# ── Pipelines ──────────────────────────────────────────────────────────────────

# Mirrors `.github/workflows/ci.yml` step-for-step.
.PHONY: ci
ci: audit lint typecheck test
	@echo ""
	@echo "✓ CI pipeline passed locally."

# Mirrors `.github/workflows/release.yml` up to (but NOT including) `npm publish`
# / `git push` / GitHub release creation. Those side-effecting steps are left to
# the GitHub Actions runner — running them from a developer machine would mint
# tags and publish packages without provenance.
.PHONY: release release-version-check
release: ci build release-version-check
	@echo ""
	@echo "✓ Release pipeline passed locally (publish steps skipped — push main to trigger CI)."

release-version-check:
	@version=$$(node -p "require('./package.json').version"); \
	tag="v$$version"; \
	if git ls-remote --exit-code --tags origin "refs/tags/$$tag" >/dev/null 2>&1; then \
	  echo "::error::Tag $$tag already exists. Bump package.json before merging to main."; \
	  exit 1; \
	fi; \
	if npm view "$(PACKAGE_NAME)@$$version" version >/dev/null 2>&1; then \
	  echo "::error::$(PACKAGE_NAME)@$$version is already published. Bump package.json before merging to main."; \
	  exit 1; \
	fi; \
	echo "✓ Version $$version not yet released."
