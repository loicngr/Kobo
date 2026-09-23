import { defineStore } from 'pinia'
import { compareVersions } from 'src/utils/compare-versions'
import { computed, ref } from 'vue'

const DISMISSED_UPDATE_KEY = 'kobo:dismissed-update-version'
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const isVersion = (value: unknown): value is string => typeof value === 'string' && STABLE_VERSION.test(value)

/** One banner state shared by the initial changelog load, reconnects and live checks. */
export const useUpdateStore = defineStore('update', () => {
  const currentVersion = ref<string | null>(null)
  const latestVersion = ref<string | null>(null)
  const dismissedVersion = ref(localStorage.getItem(DISMISSED_UPDATE_KEY))
  const lastAttemptAt = ref<string | null>(null)
  const lastSuccessAt = ref<string | null>(null)
  const checkStatus = ref<'unknown' | 'success' | 'failed'>('unknown')
  let inFlight: Promise<void> | null = null

  const availableVersion = computed(() =>
    latestVersion.value &&
    currentVersion.value &&
    compareVersions(latestVersion.value, currentVersion.value) > 0 &&
    latestVersion.value !== dismissedVersion.value
      ? latestVersion.value
      : null,
  )

  function applySnapshot(payload: Record<string, unknown>): void {
    if (!isVersion(payload.currentVersion)) return
    const attempt =
      typeof payload.lastAttemptAt === 'string' && Number.isFinite(Date.parse(payload.lastAttemptAt))
        ? payload.lastAttemptAt
        : null
    if (lastAttemptAt.value && (!attempt || Date.parse(attempt) < Date.parse(lastAttemptAt.value))) return
    currentVersion.value = payload.currentVersion
    if (isVersion(payload.latestVersion)) latestVersion.value = payload.latestVersion
    if (attempt) lastAttemptAt.value = attempt
    if (typeof payload.lastSuccessAt === 'string') lastSuccessAt.value = payload.lastSuccessAt
    if (payload.checkStatus === 'success' || payload.checkStatus === 'failed' || payload.checkStatus === 'unknown') {
      checkStatus.value = payload.checkStatus
    }
  }

  function refreshSnapshot(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const response = await fetch('/api/changelog')
        if (response.ok) applySnapshot(await response.json())
      } catch {
        /* Offline clients retain the last known update. */
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  function dismissUpdate(): void {
    const version = availableVersion.value
    if (!version) return
    dismissedVersion.value = version
    localStorage.setItem(DISMISSED_UPDATE_KEY, version)
  }

  return {
    currentVersion,
    latestVersion,
    availableVersion,
    lastAttemptAt,
    lastSuccessAt,
    checkStatus,
    applySnapshot,
    refreshSnapshot,
    dismissUpdate,
  }
})
