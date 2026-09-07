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

  it('never imports the barrel, which drags in the worker-backed services', () => {
    // `import('monaco-editor')` resolves to esm/vs/index.js, which pulls in
    // vs/language/{typescript,css,html,json}. Vite then emits their workers —
    // 8.8 MB of chunks nothing ever instantiates — into the published package.
    // Type positions (`typeof import('monaco-editor')`) are erased and emit
    // nothing; only a value import reaches the bundler.
    expect(source).not.toMatch(/from 'monaco-editor'/)
    expect(source).not.toMatch(/await import\('monaco-editor'\)/)
  })

  it('loads the editor API, the main-thread grammars and the contributions, and nothing else', () => {
    const dynamicImports = source.match(/import\('(?:monaco-editor|src)\/[^']+'\)/g) ?? []
    expect(dynamicImports).toEqual([
      "import('monaco-editor/editor/editor.api.js')",
      "import('monaco-editor/basic-languages/monaco.contribution.js')",
      "import('src/monaco-contributions')",
    ])
  })
})

describe('monaco contributions module', () => {
  // `editor.api.js` is the bare editor: typing and arrows, nothing else. The
  // find widget, context menu, folding and the diff navigation are separate
  // side-effect modules that `editor.main.js` used to pull in for us. Dropping
  // the barrel silently dropped them once — this locks each one by name.
  const source = readClient('src/monaco-contributions.ts')

  it.each([
    'editor/contrib/find/browser/findController.js',
    'editor/contrib/contextmenu/browser/contextmenu.js',
    'editor/contrib/folding/browser/folding.js',
    'editor/contrib/bracketMatching/browser/bracketMatching.js',
    'editor/contrib/hover/browser/hoverContribution.js',
    'editor/contrib/multicursor/browser/multicursor.js',
    'editor/contrib/linesOperations/browser/linesOperations.js',
    'editor/contrib/comment/browser/comment.js',
    'editor/contrib/clipboard/browser/clipboard.js',
    'editor/contrib/wordHighlighter/browser/wordHighlighter.js',
    'editor/browser/widget/diffEditor/diffEditor.contribution.js',
    'editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js',
  ])('registers %s', (module) => {
    expect(source).toContain(`import 'monaco-editor/${module}'`)
  })

  it('never registers a worker-backed language service or the LSP client', () => {
    // Import statements only: the header comment is allowed to name what it
    // leaves out.
    const imports = source.match(/^import '[^']+'/gm) ?? []
    expect(imports.length).toBeGreaterThan(50)
    for (const line of imports) {
      expect(line).not.toMatch(/languages\/features\//)
      expect(line).not.toMatch(/monaco-lsp-client/)
      expect(line).not.toMatch(/editor\.main/)
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
