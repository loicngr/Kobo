import { expect, it } from 'vitest'
import { commitWebUrl } from '../server/utils/commit-url.js'

const sha = 'a'.repeat(40)
it('opens commits on GitHub, GitLab and Bitbucket without exposing credentials', () => {
  expect(commitWebUrl('git@github.com:org/repo.git', 'github', sha)).toBe(`https://github.com/org/repo/commit/${sha}`)
  expect(commitWebUrl('https://user:secret@gitlab.example/team/sub/repo.git', 'gitlab', sha)).toBe(
    `https://gitlab.example/team/sub/repo/-/commit/${sha}`,
  )
  expect(commitWebUrl('ssh://git@bitbucket.org:22/org/repo.git', 'bitbucket-community', sha)).toBe(
    `https://bitbucket.org/org/repo/commits/${sha}`,
  )
})
it('rejects local remotes, unsupported forges and non-SHA input', () => {
  expect(commitWebUrl('/local/repo', 'github', sha)).toBeNull()
  expect(commitWebUrl('file:///local/repo', 'github', sha)).toBeNull()
  expect(commitWebUrl('https://github.com/org/repo', 'none', sha)).toBeNull()
  expect(commitWebUrl('https://github.com/org/repo', 'github', '../bad')).toBeNull()
})
