// Scan reachable history plus the publishable current files, without printing secrets.
// Install Gitleaks 8.30.1 separately; CI verifies the pinned binary checksum.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const binary = process.env.GITLEAKS_BINARY || 'gitleaks'
const version = execFileSync(binary, ['version'], { encoding: 'utf8' }).trim()
if (!version.includes('8.30.1')) throw new Error('Use the reviewed Gitleaks version 8.30.1')
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const temporary = mkdtempSync(path.join(os.tmpdir(), 'kobo-secrets-'))
let failed = false
try {
  const history = spawnSync(binary, ['git', '--redact=100', '--no-banner', '--log-opts=--all', root], { cwd: root, stdio: 'inherit' })
  failed ||= history.status !== 0
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  for (const file of files) {
    const source = path.join(root, file)
    if (!existsSync(source) || !lstatSync(source).isFile()) continue
    const destination = path.join(temporary, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  const current = spawnSync(binary, ['dir', '--redact=100', '--no-banner', temporary], { cwd: root, stdio: 'inherit' })
  failed ||= current.status !== 0
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
