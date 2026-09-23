import { describe, expect, it } from 'vitest'
import { slugifyProjectName } from '../server/utils/project-slug.js'

describe('slugifyProjectName', () => {
  it('lowercases plain ASCII names', () => {
    expect(slugifyProjectName('Sekur', '/x')).toBe('sekur')
  })

  it('replaces whitespace with a single dash', () => {
    expect(slugifyProjectName('Mon Projet', '/x')).toBe('mon-projet')
  })

  it('strips diacritics via NFD normalization', () => {
    expect(slugifyProjectName('Éphèmère', '/x')).toBe('ephemere')
  })

  it('collapses runs of special chars into a single dash', () => {
    expect(slugifyProjectName('a/b\\c:d', '/x')).toBe('a-b-c-d')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugifyProjectName('--foo--', '/x')).toBe('foo')
  })

  it('falls back to path basename when displayName is empty', () => {
    expect(slugifyProjectName('', '/home/user/Sekur')).toBe('sekur')
  })

  it('falls back to path basename when displayName is whitespace only', () => {
    expect(slugifyProjectName('   ', '/home/user/Sekur')).toBe('sekur')
  })

  it('returns "project" when both displayName and basename are empty', () => {
    expect(slugifyProjectName('', '')).toBe('project')
  })

  it('returns "project" when both displayName and basename slugify to empty', () => {
    expect(slugifyProjectName('!!!', '/!!!')).toBe('project')
  })

  it('appends -project to Windows reserved names', () => {
    expect(slugifyProjectName('CON', '/x')).toBe('con-project')
    expect(slugifyProjectName('com1', '/x')).toBe('com1-project')
    expect(slugifyProjectName('lpt9', '/x')).toBe('lpt9-project')
    expect(slugifyProjectName('aux', '/x')).toBe('aux-project')
  })

  it('does not flag names that merely contain a reserved fragment', () => {
    expect(slugifyProjectName('console', '/x')).toBe('console')
  })
})
