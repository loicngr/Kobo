import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface TempRepo {
  /** The clone under test — pass this as `projectPath`. */
  path: string
  /** The bare repository it was cloned from — stand-in for `origin`. */
  originPath: string
  git(args: string[], cwd?: string): string
  /** Commit a file with the given content on the current branch. */
  commit(file: string, content: string, message: string): void
  cleanup(): void
}

/** Create a bare origin plus a clone with one commit on `main`. */
export function createTempRepo(): TempRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kobo-prco-'))
  const originPath = path.join(root, 'origin.git')
  const repoPath = path.join(root, 'repo')

  const run = (args: string[], cwd: string): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@e.x',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@e.x',
      },
    }).trim()

  fs.mkdirSync(originPath, { recursive: true })
  run(['init', '--bare', '--initial-branch=main', '.'], originPath)
  run(['clone', originPath, repoPath], root)

  const repo: TempRepo = {
    path: repoPath,
    originPath,
    git: (args, cwd) => run(args, cwd ?? repoPath),
    commit(file, content, message) {
      const abs = path.join(repoPath, file)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      run(['add', file], repoPath)
      run(['commit', '-m', message], repoPath)
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }

  repo.commit('README.md', '# temp\n', 'chore: init')
  repo.git(['push', 'origin', 'main'])
  return repo
}
