## Summary

<!-- What does this PR do and why? One or two sentences. -->

## Changes

<!-- Bulleted list of concrete changes. Group by area (backend / frontend / MCP / CI / docs) if helpful. -->

- 
- 

## Testing

<!-- How was this validated? -->

- [ ] `npm test` (backend) passes
- [ ] `npm run test:client` (frontend) passes
- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Manual smoke test (describe below)

<!-- Manual test notes, screenshots, or video if UI-facing. -->

## Schema / migrations

<!-- Remove this section if the PR doesn't touch the DB or settings.json. -->

- [ ] DB schema changed → migration added in `src/server/db/migrations.ts` and `initSchema` updated
- [ ] `settings.json` schema changed → migration added in `runSettingsMigrations` and `SETTINGS_SCHEMA_VERSION` bumped
- [ ] Migration tested against both fresh-install and existing-install paths

## Breaking changes

<!-- Remove if none. Otherwise describe the impact on existing users. -->

None.

## Checklist

- [ ] Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) format
- [ ] No `Co-Authored-By:` trailer (per project convention)
- [ ] Branch is rebased on `develop` (not merged)
- [ ] Relevant CLAUDE.md / AGENTS.md sections reviewed if conventions changed

## Related issues

<!-- Closes #123 / Refs #456 -->
