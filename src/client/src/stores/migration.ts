import { defineStore } from 'pinia'
import { ref } from 'vue'

// Mirror of the backend `ContentMigrationStatus` discriminated union
// (see src/server/services/content-migration-service.ts). Kept verbatim
// because the frontend has its own tsconfig + package root and cannot
// import the backend file directly.
export type MigrationStatus =
  | { state: 'idle' }
  | { state: 'backing-up'; startedAt: string }
  | { state: 'running'; total: number; processed: number; startedAt: string; backupPath?: string }
  | {
      state: 'done'
      total: number
      processed: number
      startedAt: string
      finishedAt: string
      backupPath?: string
    }
  | {
      state: 'error'
      errorMessage: string
      startedAt?: string
      backupPath?: string
      total?: number
      processed?: number
    }

export const useMigrationStore = defineStore('migration', () => {
  const status = ref<MigrationStatus>({ state: 'idle' })

  async function fetchInitial(): Promise<void> {
    try {
      const res = await fetch('/api/migration/status')
      if (!res.ok) return
      status.value = (await res.json()) as MigrationStatus
    } catch {
      // network error — leave default
    }
  }

  function update(payload: MigrationStatus): void {
    status.value = { ...payload }
  }

  return { status, fetchInitial, update }
})
