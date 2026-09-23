/**
 * Picks a readable foreground colour (`#ffffff` or `#1a1a1a`) for a given
 * 6-hex background. Uses relative luminance (sRGB → linear → Y); threshold 0.5.
 * GitHub label colours arrive without a leading `#`; we accept both.
 * On malformed input, defaults to light text — visible on the chip's
 * background which itself defaults to dark in our app palette.
 */
export function pickReadableForeground(hex: string): string {
  const clean = hex.replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return '#ffffff'

  const r = Number.parseInt(clean.slice(0, 2), 16) / 255
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const y = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)

  return y < 0.5 ? '#ffffff' : '#1a1a1a'
}
