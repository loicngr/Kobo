import { getPackageVersion } from '../utils/paths.js'
import { broadcastAll } from './websocket-service.js'

export const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000
const REGISTRY_URL = 'https://registry.npmjs.org/@loicngr/kobo/latest'
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export interface UpdateCheckSnapshot {
  currentVersion: string
  latestVersion: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  checkStatus: 'unknown' | 'success' | 'failed'
}

let latestVersion: string | null = null
let lastAttempt: number | null = null
let lastSuccessAt: string | null = null
let checkStatus: UpdateCheckSnapshot['checkStatus'] = 'unknown'
let inFlight: Promise<UpdateCheckSnapshot> | null = null
let controller: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let generation = 0
let stopped = false

export function getUpdateCheckSnapshot(): UpdateCheckSnapshot {
  return {
    currentVersion: getPackageVersion(),
    latestVersion,
    lastAttemptAt: lastAttempt === null ? null : new Date(lastAttempt).toISOString(),
    lastSuccessAt,
    checkStatus,
  }
}

/** Shared by HTTP loads and the single process-wide poller; failures are cached too. */
export function refreshUpdateCheck(): Promise<UpdateCheckSnapshot> {
  if (inFlight) return inFlight
  if (stopped || (lastAttempt !== null && Date.now() - lastAttempt < UPDATE_CHECK_INTERVAL_MS)) {
    return Promise.resolve(getUpdateCheckSnapshot())
  }
  lastAttempt = Date.now()
  const owner = generation
  const abort = new AbortController()
  controller = abort
  const timeout = setTimeout(() => abort.abort(), 5000)
  timeout.unref?.()
  const aborted = new Promise<never>((_, reject) => {
    abort.signal.addEventListener('abort', () => reject(new Error('Update lookup cancelled')), { once: true })
  })
  const lookup = (async () => {
    const res = await fetch(REGISTRY_URL, { signal: abort.signal })
    if (!res.ok) throw new Error('Registry lookup failed')
    const body: unknown = await res.json()
    if (
      !body ||
      typeof body !== 'object' ||
      !('version' in body) ||
      typeof body.version !== 'string' ||
      !STABLE_VERSION.test(body.version)
    ) {
      throw new Error('Invalid registry version')
    }
    return body.version
  })()
  inFlight = (async () => {
    try {
      const version = await Promise.race([lookup, aborted])
      if (owner !== generation) return getUpdateCheckSnapshot()
      latestVersion = version
      lastSuccessAt = new Date().toISOString()
      checkStatus = 'success'
    } catch {
      if (owner !== generation) return getUpdateCheckSnapshot()
      checkStatus = 'failed'
    } finally {
      clearTimeout(timeout)
      if (owner === generation) {
        inFlight = null
        controller = null
      }
    }
    const snapshot = getUpdateCheckSnapshot()
    broadcastAll('kobo:update-checked', snapshot)
    return snapshot
  })()
  return inFlight
}

function scheduleNextCheck(owner: number): void {
  if (!running || owner !== generation) return
  const delay = lastAttempt === null ? 0 : Math.max(0, UPDATE_CHECK_INTERVAL_MS - (Date.now() - lastAttempt))
  timer = setTimeout(() => {
    timer = null
    void refreshUpdateCheck().finally(() => scheduleNextCheck(owner))
  }, delay)
  timer.unref?.()
}

export function startUpdateChecker(): void {
  if (running) return
  running = true
  stopped = false
  const owner = generation
  void refreshUpdateCheck().finally(() => scheduleNextCheck(owner))
}

export function stopUpdateChecker(): void {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
  stopped = true
  generation++
  controller?.abort()
  controller = null
  inFlight = null
}

/** @internal test-only — clear the scheduler and registry cache. */
export function _clearLatestVersionCache(): void {
  stopUpdateChecker()
  stopped = false
  latestVersion = null
  lastAttempt = null
  lastSuccessAt = null
  checkStatus = 'unknown'
}
