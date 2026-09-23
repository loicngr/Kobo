export function workspacePageStyle(offset: number, viewportHeight: number) {
  const availableHeight = Math.max(0, viewportHeight - offset)
  const height = `calc(${availableHeight}px - var(--kobo-pwa-banner-height, 0px))`

  return { height, minHeight: height }
}
