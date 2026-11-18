import { useQuasar } from 'quasar'
import { useWorkspaceStore, WorkspaceActionError } from 'src/stores/workspace'
import { showRestoreWarnings } from 'src/utils/restore-warnings'
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
    const workspaceName = [...store.workspaces, ...store.archivedWorkspaces].find((w) => w.id === id)?.name
    try {
      const { warnings } = await store.restoreWorktree(id)
      if (warnings.length === 0) {
        $q.notify({ type: 'positive', message: t('workspacePage.worktreeRestoreSuccess'), position: 'top' })
      }
      showRestoreWarnings($q, t, warnings, { workspaceId: id, workspaceName })
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
