import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '../stores/settings'
import type { Workspace } from '../stores/workspace'
import {
  PROJECT_COLOR_PALETTE,
  PROJECT_COLOR_TEXT_CONTRAST,
  projectColorFor,
  projectNameFor,
  projectTextColorFor,
} from '../utils/project-color'

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'My workspace',
    projectPath: '/home/user/projects/foo',
    sourceBranch: 'develop',
    workingBranch: 'feature/x',
    status: 'idle',
    notionUrl: null,
    sentryUrl: null,
    notionPageId: null,
    model: 'claude',
    engine: 'claude-code',
    reasoningEffort: 'auto',
    permissionMode: 'auto-accept',
    devServerStatus: 'stopped',
    hasUnread: false,
    archivedAt: null,
    favoritedAt: null,
    tags: [],
    autoLoop: false,
    autoLoopReady: false,
    noProgressStreak: 0,
    permissionProfile: 'bypass',
    worktreePath: '/tmp/wt',
    worktreeOwned: true,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as Workspace
}

describe('project-color utils', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('PROJECT_COLOR_PALETTE has 12 entries', () => {
    expect(PROJECT_COLOR_PALETTE).toHaveLength(12)
  })

  it('PROJECT_COLOR_TEXT_CONTRAST maps every palette colour', () => {
    for (const c of PROJECT_COLOR_PALETTE) {
      expect(PROJECT_COLOR_TEXT_CONTRAST[c]).toMatch(/^(white|grey-9)$/)
    }
  })

  it('projectColorFor returns null when project has no settings', () => {
    const ws = makeWorkspace()
    expect(projectColorFor(ws)).toBeNull()
  })

  it('projectColorFor returns the project color when set', () => {
    const store = useSettingsStore()
    store.projects = [{ path: '/home/user/projects/foo', displayName: '', color: 'purple-5' } as never]
    expect(projectColorFor(makeWorkspace({ projectPath: '/home/user/projects/foo' }))).toBe('purple-5')
  })

  it('projectNameFor uses displayName when set', () => {
    const store = useSettingsStore()
    store.projects = [{ path: '/home/user/projects/foo', displayName: 'Foo Project', color: null } as never]
    expect(projectNameFor(makeWorkspace())).toBe('Foo Project')
  })

  it('projectNameFor falls back to basename of projectPath when displayName is empty', () => {
    expect(projectNameFor(makeWorkspace({ projectPath: '/home/user/projects/bar' }))).toBe('bar')
  })

  it('projectNameFor strips trailing slashes', () => {
    expect(projectNameFor(makeWorkspace({ projectPath: '/home/user/projects/baz/' }))).toBe('baz')
  })

  it('projectTextColorFor returns grey-3 for a project without color', () => {
    expect(projectTextColorFor(makeWorkspace())).toBe('grey-3')
  })

  it('projectTextColorFor uses contrast map when color is set', () => {
    const store = useSettingsStore()
    store.projects = [{ path: '/home/user/projects/foo', displayName: '', color: 'cyan-5' } as never]
    expect(projectTextColorFor(makeWorkspace())).toBe('grey-9')
  })
})
