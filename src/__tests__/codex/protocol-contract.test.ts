import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveCodexBinary } from '../../server/services/agent/engines/codex/spawn.js'

it('keeps consumed turn requests and responses compatible with the installed Codex protocol', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kobo-codex-contract-'))
  try {
    execFileSync(resolveCodexBinary(), ['app-server', 'generate-ts', '--out', directory], {
      timeout: 30_000,
      stdio: 'pipe',
    })
    const local = fileURLToPath(new URL('../../server/services/agent/engines/codex/protocol/types.ts', import.meta.url))
    const requests = ['TurnStartParams', 'TurnSteerParams', 'TurnInterruptParams']
    const responses = [
      'TurnStartResponse',
      'TurnSteerResponse',
      'ThreadStartResponse',
      'ErrorNotification',
      'TurnCompletedNotification',
      'FileChangeRequestApprovalParams',
    ]
    const source = [
      `import type * as Local from ${JSON.stringify(local)}`,
      'type Assert<T extends true> = T',
      "import type { ThreadItem } from './v2/ThreadItem'",
      "type FileChangeContract = Assert<Extract<ThreadItem, {type: 'fileChange'}> extends Local.FileChangeItem ? true : false>",
    ]
    for (const [index, name] of [...requests, ...responses].entries()) {
      source.push(`import type { ${name} as Canonical${index} } from './v2/${name}'`)
      source.push(
        requests.includes(name)
          ? `type Check${index} = Assert<Local.${name} extends Canonical${index} ? true : false>`
          : `type Check${index} = Assert<Canonical${index} extends Local.${name} ? true : false>`,
      )
    }
    const contract = join(directory, 'contract.ts')
    writeFileSync(contract, source.join('\n'))
    // TypeScript 7 no longer ships the in-process compiler API: run its CLI.
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          allowImportingTsExtensions: true,
          types: [],
        },
        files: [contract],
      }),
    )
    const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
    const result = spawnSync(process.execPath, [tsc, '-p', directory], { encoding: 'utf8', timeout: 30_000 })
    expect(`${result.stdout}${result.stderr}`.trim()).toBe('')
    expect(result.status).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 45_000)
