// `npm audit --audit-level=high` with a narrow, documented allowlist.
// Usage: node scripts/audit-check.mjs [directory]   (default: current directory)
//        node scripts/audit-check.mjs --self-test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// Advisories tolerated until a fixed release exists. Remove an entry as soon as the
// audit stops reporting it (the script says so). Never add one for a runtime dependency
// of the published server without reading the advisory.
const ALLOWED = {
  // picomatch ReDoS, every release up to 4.0.7 (the latest, checked 2026-11-18). It reaches
  // the three trees through build and test tooling only (vitest, vite, workbox-build, vue-tsc);
  // the glob patterns it compiles there come from project configuration, never from a request.
  'GHSA-fc5q-39xc-vjpf': 'picomatch ReDoS, no fixed release yet; build and test tooling only',
}

/** High and critical advisories of an `npm audit --json` report, split by the allowlist. */
export function classify(report, allowed = ALLOWED) {
  const blocking = new Map()
  const tolerated = new Set()
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A string entry only points at another vulnerable package; its advisory is listed there.
      if (typeof via !== 'object' || via === null) continue
      if (via.severity !== 'high' && via.severity !== 'critical') continue
      const id = /GHSA-[0-9a-z-]+/i.exec(via.url ?? '')?.[0] ?? String(via.source ?? via.title ?? 'unknown')
      if (Object.hasOwn(allowed, id)) tolerated.add(id)
      else blocking.set(id, `${via.name ?? 'unknown package'}: ${via.title ?? 'no title'} (${via.url ?? 'no url'})`)
    }
  }
  return { blocking, tolerated }
}

function selfTest() {
  const advisory = (id, severity) => ({ name: 'pkg', title: 't', severity, url: `https://github.com/advisories/${id}` })
  const report = {
    vulnerabilities: {
      a: { via: [advisory('GHSA-aaaa-aaaa-aaaa', 'high')] },
      b: { via: ['a', advisory('GHSA-bbbb-bbbb-bbbb', 'moderate')] },
      c: { via: [advisory('GHSA-cccc-cccc-cccc', 'critical')] },
    },
  }
  const all = classify(report, {})
  assert.deepEqual([...all.blocking.keys()], ['GHSA-aaaa-aaaa-aaaa', 'GHSA-cccc-cccc-cccc'])
  const some = classify(report, { 'GHSA-aaaa-aaaa-aaaa': 'reason' })
  assert.deepEqual([...some.blocking.keys()], ['GHSA-cccc-cccc-cccc'])
  assert.deepEqual([...some.tolerated], ['GHSA-aaaa-aaaa-aaaa'])
  assert.equal(classify({}, {}).blocking.size, 0)
  console.log('audit-check self-test passed')
}

function main(directory) {
  // npm exits non-zero whenever it finds anything: the JSON report is what decides.
  const run = spawnSync('npm', ['audit', '--json'], { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let report
  try {
    report = JSON.parse(run.stdout)
  } catch {
    console.error(`npm audit gave no JSON report in '${directory}'.`)
    if (run.stderr) console.error(run.stderr.trim())
    process.exit(2)
  }
  if (report.error) {
    console.error(`npm audit failed in '${directory}': ${report.error.summary ?? report.error.code ?? 'unknown error'}`)
    process.exit(2)
  }
  const { blocking, tolerated } = classify(report)
  for (const id of tolerated) console.log(`Tolerated in '${directory}': ${id} - ${ALLOWED[id]}`)
  for (const id of Object.keys(ALLOWED)) {
    if (!tolerated.has(id)) console.log(`Note: ${id} is no longer reported in '${directory}'.`)
  }
  if (blocking.size > 0) {
    console.error(`${blocking.size} high or critical advisory(ies) in '${directory}':`)
    for (const [id, text] of blocking) console.error(`  ${id} - ${text}`)
    process.exit(1)
  }
  console.log(`No blocking advisory in '${directory}'.`)
}

if (process.argv[2] === '--self-test') selfTest()
else main(process.argv[2] ?? '.')
