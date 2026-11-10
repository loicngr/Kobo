// Render only SGR formatting as Vue text spans, never HTML from a job.
export interface LogSpan {
  text: string
  style: { color?: string; backgroundColor?: string; fontWeight?: string }
}
const palette = [
  '#484f58',
  '#ff7b72',
  '#7ee787',
  '#e3b341',
  '#79c0ff',
  '#d2a8ff',
  '#76e3ea',
  '#c9d1d9',
  '#8b949e',
  '#ffa198',
  '#aff5b4',
  '#f8e3a1',
  '#a5d6ff',
  '#e2c5ff',
  '#b3f0ff',
  '#ffffff',
]
function indexedColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return
  if (index < 16) return palette[index]
  if (index >= 232) {
    const n = 8 + (index - 232) * 10
    return `rgb(${n}, ${n}, ${n})`
  }
  const n = index - 16
  const level = (value: number) => (value === 0 ? 0 : 55 + value * 40)
  return `rgb(${level(Math.floor(n / 36))}, ${level(Math.floor(n / 6) % 6)}, ${level(n % 6)})`
}
export function ciLogSpans(logs: string): LogSpan[] {
  const result: LogSpan[] = []
  let style: LogSpan['style'] = {}
  let start = 0
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences start with ESC.
  for (const match of logs.matchAll(/\x1b\[([\d;]*)m/g)) {
    if (match.index > start) result.push({ text: logs.slice(start, match.index), style: { ...style } })
    const codes = match[1]!.split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!
      if (code === 0) style = {}
      else if (code === 1) style.fontWeight = 'bold'
      else if (code === 22) delete style.fontWeight
      else if (code === 39) delete style.color
      else if (code === 49) delete style.backgroundColor
      else if (code >= 30 && code <= 37) style.color = palette[code - 30]
      else if (code >= 90 && code <= 97) style.color = palette[code - 90 + 8]
      else if (code >= 40 && code <= 47) style.backgroundColor = palette[code - 40]
      else if (code >= 100 && code <= 107) style.backgroundColor = palette[code - 100 + 8]
      else if (code === 38 || code === 48) {
        const target = code === 38 ? 'color' : 'backgroundColor'
        const mode = codes[++i]
        if (mode === 5) style[target] = indexedColor(codes[++i]!)
        else if (mode === 2) {
          const rgb = codes.slice(i + 1, i + 4)
          i += 3
          if (rgb.length === 3 && rgb.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
            style[target] = `rgb(${rgb.join(', ')})`
        }
      }
    }
    start = match.index + match[0].length
  }
  if (start < logs.length) result.push({ text: logs.slice(start), style: { ...style } })
  return result
}

export function ciStepAppearance(status: string, conclusion: string | null) {
  if (status.toLowerCase() !== 'completed') return { color: 'warning', icon: 'hourglass_top' }
  if (conclusion?.toLowerCase() === 'success') return { color: 'positive', icon: 'check_circle' }
  if (['failure', 'timed_out', 'action_required', 'startup_failure'].includes(conclusion?.toLowerCase() ?? ''))
    return { color: 'negative', icon: 'cancel' }
  return { color: 'grey-6', icon: 'remove_circle_outline' }
}
