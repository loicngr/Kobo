import { useQuasar } from 'quasar'
import { useWorkspaceStore, WorkspaceActionError } from 'src/stores/workspace'
import { useI18n } from 'vue-i18n'

const restoreErrorCodes = new Set([
  'not-found',
  'not-purged',
  'workspace-busy',
  'worktree-not-owned',
  'project-unavailable',
  'path-conflict',
  'branch-in-use',
  'recovery-source-unavailable',
  'git-failed',
])

const manualRecoveryUrl = 'https://github.com/loicngr/kobo/blob/develop/CONFIGURATION.md#restoring-a-purged-workspace'

/** Shared feedback for the sidebar and the open conversation. */
export function useWorktreeRestore() {
  const store = useWorkspaceStore()
  const $q = useQuasar()
  const { t } = useI18n()

  async function restoreWorktree(id: string) {
    if (store.restoringWorktreeIds.includes(id)) return
    try {
      await store.restoreWorktree(id)
      $q.notify({ type: 'positive', message: t('workspacePage.worktreeRestoreSuccess'), position: 'top' })
    } catch (error) {
      const code =
        error instanceof WorkspaceActionError && error.code && restoreErrorCodes.has(error.code)
          ? error.code
          : 'git-failed'
      $q.notify({
        type: 'negative',
        message: t(`workspacePage.restoreError.${code}`),
        position: 'top',
        actions: [
          {
            label: t('common.details'),
            handler: () => window.open(manualRecoveryUrl, '_blank', 'noopener,noreferrer'),
          },
        ],
      })
    }
  }

  return { restoreWorktree }
}
