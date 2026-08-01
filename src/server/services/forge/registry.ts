// src/server/services/forge/registry.ts
import { bitbucketProvider } from './bitbucket/provider.js'
import { githubProvider } from './github/provider.js'
import { gitlabProvider } from './gitlab/provider.js'
import { noneProvider } from './none.js'
import type { ForgeId, ForgeProvider } from './types.js'

const PROVIDERS: Record<ForgeId, ForgeProvider> = {
  github: githubProvider,
  gitlab: gitlabProvider,
  'bitbucket-community': bitbucketProvider,
  none: noneProvider,
}

/** Resolve a provider by id. Unknown ids fall back to the none provider. */
export function getForgeProvider(id: ForgeId): ForgeProvider {
  return PROVIDERS[id] ?? noneProvider
}

/** The selectable forge ids, in display order. */
export function listForges(): ForgeId[] {
  return ['github', 'gitlab', 'bitbucket-community', 'none']
}
