import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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
    const program = ts.createProgram([contract], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      types: [],
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 45_000)
