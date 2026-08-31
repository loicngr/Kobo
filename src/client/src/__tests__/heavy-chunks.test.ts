// Source assertions: what matters here is what the bundler is ASKED to emit,
// which is a property of the import statements, not of runtime behaviour.
// A `?worker` import emits its own chunk whether or not the code runs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readClient = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf-8')

describe('DiffViewer monaco footprint', () => {
  const source = readClient('src/components/DiffViewer.vue')

  it('imports the base editor worker and nothing else', () => {
    const workerImports = source.match(/^import .*\?worker'$/gm) ?? []
    expect(workerImports).toEqual(["import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'"])
  })

  it('hands the base worker to every label', () => {
    expect(source).toMatch(/getWorker: \(\) => new EditorWorker\(\)/)
  })

  it('turns off every worker-backed language service', () => {
    expect(source).toMatch(/disableWorkerBackedLanguageServices\(monaco\)/)
    for (const defaults of [
      'typescriptDefaults',
      'javascriptDefaults',
      'cssDefaults',
      'scssDefaults',
      'lessDefaults',
      'jsonDefaults',
      'htmlDefaults',
      'handlebarDefaults',
      'razorDefaults',
    ]) {
      expect(source).toContain(`${defaults}.setModeConfiguration(NO_LANGUAGE_PROVIDERS)`)
    }
  })
})

describe('MainLayout panel footprint', () => {
  const source = readClient('src/layouts/MainLayout.vue')

  it('loads the four heavy panels on demand', () => {
    for (const panel of ['GitPanel', 'TerminalPanel', 'DocumentsPanel', 'SchedulePanel']) {
      expect(source).not.toMatch(new RegExp(`^import ${panel} from`, 'm'))
      expect(source).toContain(`const ${panel} = defineAsyncComponent(() => import('src/components/${panel}.vue'))`)
    }
  })
})
