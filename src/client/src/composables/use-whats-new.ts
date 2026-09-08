import { compareVersions } from 'src/utils/compare-versions'
import { ref } from 'vue'

const LAST_SEEN_KEY = 'kobo:last-seen-version'
const DISMISSED_UPDATE_KEY = 'kobo:dismissed-update-version'

export interface ChangelogEntry {
  version: string
  notes: string
}

/**
 * "What's new" dialog logic: on app load, compares the running version to the
 * last one the user saw (`localStorage`). On an upgrade, surfaces the changelog
 * entries for every version released in between.
 */
export function useWhatsNew() {
  const showDialog = ref(false)
  const newVersions = ref<ChangelogEntry[]>([])
  /**
   * A newer version exists on npm. Null when we are current, when the registry
   * could not be reached, or when the user dismissed this particular version.
   * "What's new" tells you what changed after you upgraded; this is the half
   * that tells you an upgrade exists at all.
   */
  const availableVersion = ref<string | null>(null)

  async function checkForUpdate(): Promise<void> {
    try {
      const res = await fetch('/api/changelog')
      if (!res.ok) return
      const body = (await res.json()) as {
        currentVersion?: string
        latestVersion?: string | null
        versions?: ChangelogEntry[]
      }
      const current = body.currentVersion
      if (!current) return

      const latest = body.latestVersion
      if (latest && compareVersions(latest, current) > 0 && localStorage.getItem(DISMISSED_UPDATE_KEY) !== latest) {
        availableVersion.value = latest
      }

      const lastSeen = localStorage.getItem(LAST_SEEN_KEY)
      // First launch - just record the version. No dialog: the home tour
      // is what greets a brand-new user.
      if (!lastSeen) {
        localStorage.setItem(LAST_SEEN_KEY, current)
        return
      }
      if (lastSeen === current) return

      // Every version strictly above last-seen, up to the current one,
      // newest first.
      const fresh = (body.versions ?? [])
        .filter((v) => compareVersions(v.version, lastSeen) > 0 && compareVersions(v.version, current) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version))

      localStorage.setItem(LAST_SEEN_KEY, current)
      if (fresh.length > 0) {
        newVersions.value = fresh
        showDialog.value = true
      }
    } catch {
      /* network errors are not fatal — just skip the dialog */
    }
  }

  /** Hide the banner for this version only; a later release surfaces again. */
  function dismissUpdate(): void {
    if (availableVersion.value) localStorage.setItem(DISMISSED_UPDATE_KEY, availableVersion.value)
    availableVersion.value = null
  }

  return { showDialog, newVersions, checkForUpdate, availableVersion, dismissUpdate }
}
