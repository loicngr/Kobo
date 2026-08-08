import { monacoLanguageForPath } from 'src/utils/monaco-language'
import { describe, expect, it } from 'vitest'

describe('monacoLanguageForPath', () => {
  it.each([
    ['Component.vue', 'html'],
    ['index.php', 'php'],
    ['template.phtml', 'php'],
    ['app.js', 'javascript'],
    ['module.mjs', 'javascript'],
    ['config.cjs', 'javascript'],
    ['view.jsx', 'javascript'],
    ['main.ts', 'typescript'],
    ['module.mts', 'typescript'],
    ['config.cts', 'typescript'],
    ['view.tsx', 'typescript'],
  ])('maps %s to %s', (path, language) => {
    expect(monacoLanguageForPath(path)).toBe(language)
  })

  it('handles uppercase extensions and unknown files', () => {
    expect(monacoLanguageForPath('src/Legacy.PHP')).toBe('php')
    expect(monacoLanguageForPath('README')).toBe('plaintext')
  })
})
