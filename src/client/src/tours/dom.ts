const POLL_INTERVAL_MS = 50

/**
 * True when `el` is laid out and its box intersects the viewport. A Quasar drawer hides
 * its content with a translateX, so a positive offsetWidth alone is not enough.
 */
function isOnScreen(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false
  const rect = el.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight
}

/**
 * Resolve true once `selector` is in the DOM, laid out and on screen; false once `timeout`
 * elapses first. Polls with a timer rather than requestAnimationFrame, which browsers
 * suspend in hidden tabs.
 */
export function waitForVisible(selector: string, timeout = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const el = document.querySelector<HTMLElement>(selector)
      if (el && isOnScreen(el)) resolve(true)
      else if (Date.now() - start > timeout) resolve(false)
      else setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
  })
}

export function anchorSelector(anchor: string): string {
  return `[data-tour="${anchor}"]`
}

/** Click the element carrying `data-tour="<anchor>"`, then report whether `waitFor` became visible. */
export async function clickAnchor(anchor: string, waitFor: string = anchor): Promise<boolean> {
  document.querySelector<HTMLElement>(anchorSelector(anchor))?.click()
  return waitForVisible(anchorSelector(waitFor))
}

/** True when an element carrying `data-tour="<anchor>"` is in the DOM right now (visible or not). */
export function anchorPresent(anchor: string): boolean {
  return document.querySelector(anchorSelector(anchor)) !== null
}
