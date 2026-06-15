/**
 * Effective width (px) for a side drawer.
 *
 * On large screens the user's saved width is used as-is. On small screens it is
 * capped to `screenWidth - safeMargin` so an overlay drawer can never cover the
 * whole viewport (leaving a visible strip + backdrop to tap-dismiss). Never
 * returns a negative value on very small viewports.
 */
export function cappedDrawerWidth(savedWidth: number, screenWidth: number, isSmall: boolean, safeMargin = 50): number {
  if (!isSmall) return savedWidth
  return Math.min(savedWidth, Math.max(0, screenWidth - safeMargin))
}
