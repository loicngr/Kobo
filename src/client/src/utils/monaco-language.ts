const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  cjs: 'javascript',
  css: 'css',
  cts: 'typescript',
  go: 'go',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  phtml: 'php',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  yaml: 'yaml',
  yml: 'yaml',
}

export function monacoLanguageForPath(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase()
  return (extension && LANGUAGE_BY_EXTENSION[extension]) || 'plaintext'
}
