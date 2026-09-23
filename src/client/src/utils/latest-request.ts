/**
 * Single-flight guard for a UI that fires one request per click.
 *
 * Three quick clicks in the diff file tree used to race: whichever response
 * landed last won the display, regardless of which file the user actually
 * asked for — and the sha/base snapshot taken alongside it belonged to the
 * wrong file, which made the next save inconsistent.
 *
 * `begin()` aborts the previous request and returns the new one's signal;
 * `isCurrent()` lets a resolved handler check whether it is still the one that
 * matters before touching any shared state.
 */
export interface LatestRequest {
  begin(): AbortSignal
  isCurrent(signal: AbortSignal): boolean
  abort(): void
}

export function createLatestRequest(): LatestRequest {
  let controller: AbortController | null = null
  return {
    begin(): AbortSignal {
      controller?.abort()
      controller = new AbortController()
      return controller.signal
    },
    isCurrent(signal: AbortSignal): boolean {
      return controller !== null && controller.signal === signal && !signal.aborted
    },
    abort(): void {
      controller?.abort()
      controller = null
    },
  }
}

/** True when an error is the AbortError produced by cancelling a fetch. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError'
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}
