import { compareVersions } from 'src/utils/compare-versions'
import { ref } from 'vue'

const LAST_SEEN_KEY = 'kobo:last-seen-version'

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

  async function checkForUpdate(): Promise<void> {
    try {
      const res = await fetch('/api/changelog')
      if (!res.ok) return
      const body = (await res.json()) as { currentVersion?: string; versions?: ChangelogEntry[] }
      const current = body.currentVersion
      if (!current) return

      const lastSeen = localStorage.getItem(LAST_SEEN_KEY)
      // First launch — just record the version. No dialog: the onboarding tour
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

  return { showDialog, newVersions, checkForUpdate }
}
