import fs from 'node:fs'
import { stripVTControlCharacters } from 'node:util'
import { parseChangelog } from './changelog.js'

interface StartupOptions {
  version: string
  port: number
  devClientOrigin?: string | null
  networkEnabled: boolean
  lanUrls?: string[]
  token?: string
  changelog?: string
  color?: boolean
}

/** Optional package asset: a missing changelog must never prevent startup. */
export function readStartupNotes(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

function plainHighlight(line: string): string {
  const text = stripVTControlCharacters(line)
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 92 ? `${text.slice(0, 91).trimEnd()}…` : text
}

export function formatStartupBanner(options: StartupOptions): string {
  const style = (code: number, text: string) => (options.color ? `\x1b[${code}m${text}\x1b[0m` : text)
  const url = options.devClientOrigin?.trim().replace(/\/+$/, '') || `http://localhost:${options.port}`
  const lines = [
    '',
    `  ${style(1, '工房  Kōbō')}  ${style(2, `v${options.version}`)}`,
    `  ${style(2, 'Your development workshop')}`,
    '',
    `  ${style(32, '✓')} Server ready`,
    `  → ${style(1, url)}`,
  ]
  if (options.networkEnabled) {
    for (const lanUrl of options.lanUrls ?? []) lines.push(`  LAN: ${lanUrl}`)
    if (options.token) lines.push(`  Token: ${options.token}`)
  }

  const release = parseChangelog(options.changelog ?? '').find((entry) => entry.version === options.version)
  const highlights = (release?.notes ?? '')
    .split('\n')
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => plainHighlight(line.slice(2)))
    .filter(Boolean)
  if (highlights.length > 0) {
    lines.push('', `  ${style(1, `What’s new · ${options.version}`)}`)
    for (const highlight of highlights.slice(0, 5)) lines.push(`  • ${highlight}`)
    lines.push(`  Full changelog: ${url}/#/changelog`)
  }
  lines.push(
    '',
    `  ${style(2, options.networkEnabled ? 'Network access enabled' : 'Local access only')}`,
    `  ${style(2, 'Ctrl+C to stop')}`,
    '',
  )
  return lines.join('\n')
}

/** Only animate an interactive terminal; redirected logs stay plain text. */
export function startStartupSpinner(): () => void {
  if (!process.stderr.isTTY || process.env.TERM === 'dumb') return () => {}
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let frame = 0
  const render = () => process.stderr.write(`\r  ${frames[frame++ % frames.length]} Starting Kōbō…`)
  render()
  const timer = setInterval(render, 80)
  timer.unref()
  return () => {
    clearInterval(timer)
    process.stderr.write('\r\x1b[2K')
  }
}

export function startupDebug(message: string): void {
  if (process.env.KOBO_VERBOSE === '1') console.log(message)
}
