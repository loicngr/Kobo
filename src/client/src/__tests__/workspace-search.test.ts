import { describe, expect, it } from 'vitest'
import { filterWorkspaces, matchWorkspace, workspaceSearchFields } from '../utils/workspace-search'

function ws(overrides: Partial<Parameters<typeof matchWorkspace>[1]> = {}) {
  return {
    name: 'Refonte du panneau git',
    workingBranch: 'feature/git-panel-refactor',
    sourceBranch: 'develop',
    description: 'Sortir les actions git de la carte',
    agentDescription: null,
    tags: ['ui', 'git'],
    projectPath: '/home/loic/projects/kobo',
    ...overrides,
  }
}

describe('workspaceSearchFields', () => {
  it('collects every field rendered on the card, name first', () => {
    expect(workspaceSearchFields(ws())).toEqual([
      'Refonte du panneau git',
      'feature/git-panel-refactor',
      'Sortir les actions git de la carte',
      'ui git',
      'kobo',
      'develop',
    ])
  })

  it('skips null and empty fields instead of emitting blanks', () => {
    expect(workspaceSearchFields(ws({ description: null, tags: [], sourceBranch: '' }))).toEqual([
      'Refonte du panneau git',
      'feature/git-panel-refactor',
      'kobo',
    ])
  })

  it('prefers the agent description over the user one, mirroring the card', () => {
    const fields = workspaceSearchFields(ws({ agentDescription: 'Extraction du composant de carte' }))
    expect(fields).toContain('Extraction du composant de carte')
    expect(fields).not.toContain('Sortir les actions git de la carte')
  })
})

describe('matchWorkspace', () => {
  it('matches on the branch, which the old substring-on-name filter missed', () => {
    expect(matchWorkspace('refactor', ws())).not.toBeNull()
  })

  it('matches on a tag', () => {
    expect(matchWorkspace('ui', ws())).not.toBeNull()
  })

  it('matches on the project folder name', () => {
    expect(matchWorkspace('kobo', ws())).not.toBeNull()
  })

  it('is fuzzy, not a substring test', () => {
    expect(matchWorkspace('gtpnl', ws())).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(matchWorkspace('REFONTE', ws())).not.toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchWorkspace('zzzz', ws())).toBeNull()
  })

  it('scores a name hit above a project-path hit', () => {
    const onName = matchWorkspace('refonte', ws())
    const onProject = matchWorkspace('kobo', ws())
    expect(onName).not.toBeNull()
    expect(onProject).not.toBeNull()
    expect(onName!).toBeGreaterThan(onProject!)
  })
})

describe('filterWorkspaces', () => {
  const a = { ...ws(), id: 'a' }
  const b = { ...ws({ name: 'git', workingBranch: 'fix/x', tags: [], description: null }), id: 'b' }

  it('returns the list untouched, in source order, for an empty query', () => {
    expect(filterWorkspaces('', [a, b])).toEqual([a, b])
    expect(filterWorkspaces('   ', [a, b])).toEqual([a, b])
  })

  it('drops non-matching entries', () => {
    expect(filterWorkspaces('zzzz', [a, b])).toEqual([])
  })

  it('ranks the tighter match first', () => {
    expect(filterWorkspaces('git', [a, b]).map((w) => w.id)).toEqual(['b', 'a'])
  })
})
