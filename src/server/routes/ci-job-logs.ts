import { execFile, spawn } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'
import { Hono } from 'hono'
import { type CiJobLogs, githubJobTarget } from '../../shared/ci-job-logs.js'
import { getAllPrSnapshots, refreshPrSnapshot } from '../services/pr-watcher-service.js'
import { getWorkspace } from '../services/workspace-service.js'

const exec = promisify(execFile)
const app = new Hono()

// Drain the whole download while retaining only its tail, including the final failure.
function readLogTail(args: string[], options: { cwd: string; signal: AbortSignal; timeout: number }) {
  return new Promise<{ logs: string; truncated: boolean; available: boolean }>((resolve, reject) => {
    const child = spawn('gh', args, { ...options, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] })
    const limit = 256 * 1024
    let logs = '',
      stderr = '',
      truncated = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      truncated ||= logs.length + chunk.length > limit
      logs = (logs + chunk).slice(-limit)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0)
        resolve({
          logs: logs
            // biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve only ANSI SGR formatting.
            .split(/(\x1b\[[\d;]*m)/)
            .map((part, index) => (index % 2 ? part : stripVTControlCharacters(part)))
            .join(''),
          truncated,
          available: true,
        })
      else if (
        !signal &&
        args.includes('--allow-escape-sequences') &&
        /unknown flag: --allow-escape-sequences/.test(stderr)
      )
        readLogTail(
          args.filter((arg) => arg !== '--allow-escape-sequences'),
          options,
        ).then(resolve, reject)
      else if (!signal && /HTTP (404|409)/.test(stderr)) resolve({ logs: '', truncated: false, available: false })
      else reject(new Error('GitHub log download failed'))
    })
  })
}

app.get('/:id/ci-job-logs', async (c) => {
  const workspace = getWorkspace(c.req.param('id'))
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404)
  const url = c.req.query('url') ?? ''
  const target = url.length <= 2048 ? githubJobTarget(url) : null
  const step = c.req.query('step')
  if (!target || (step !== undefined && !/^[1-9]\d{0,3}$/.test(step)))
    return c.json({ error: 'Invalid GitHub job or step' }, 400)
  try {
    const snapshot = getAllPrSnapshots()[workspace.id] ?? (await refreshPrSnapshot(workspace.id))
    // Never turn a browser-supplied URL into an authenticated arbitrary repository request.
    if (
      !snapshot?.ci.checks.some((check) => check.detailsUrl === url) ||
      snapshot.url !== `https://github.com/${target.owner}/${target.repo}/pull/${snapshot.number}`
    )
      return c.json({ error: 'Job is not linked to this workspace pull request' }, 404)
    const endpoint = `repos/${target.owner}/${target.repo}/actions/jobs/${target.jobId}`
    const options = {
      cwd: workspace.projectPath,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8' as const,
      signal: c.req.raw.signal,
    }
    const args = ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10']
    const { stdout } = await exec('gh', [...args, endpoint], options)
    const job = JSON.parse(stdout) as {
      run_id: number
      status: string
      conclusion: string | null
      steps?: CiJobLogs['steps']
    }
    if (String(job.run_id) !== target.runId) return c.json({ error: 'Job run mismatch' }, 404)
    const steps = (job.steps ?? [])
      .slice(0, 200)
      .map(({ number, name, status, conclusion }) => ({ number, name, status, conclusion }))
    if (step && !steps.some((item) => String(item.number) === step)) return c.json({ error: 'Step not found' }, 404)
    const logs = await readLogTail(
      [...args, '--allow-escape-sequences', `${endpoint}${step ? `/steps/${step}` : ''}/logs`],
      {
        cwd: workspace.projectPath,
        signal: c.req.raw.signal,
        timeout: 30_000,
      },
    )
    return c.json({ status: job.status, conclusion: job.conclusion, steps, ...logs } satisfies CiJobLogs)
  } catch {
    // CLI errors may contain credentials or signed log URLs.
    return c.json(
      { error: 'Unable to read GitHub job logs. Check GitHub CLI authentication and Actions read access.' },
      502,
    )
  }
})

export default app
