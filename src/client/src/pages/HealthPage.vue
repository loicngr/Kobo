<script setup lang="ts">
import { useQuasar } from 'quasar'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const $q = useQuasar()
const router = useRouter()

interface WorktreeCheck {
  workspaceId: string
  name: string
  path: string
  exists: boolean
}

interface HealthReport {
  koboHome: string
  db: { path: string; sizeBytes: number | null; schemaVersion: number; currentSchemaVersion: number }
  settings: { schemaVersion: number }
  claudeCli: { available: boolean; version: string | null }
  workspaces: { total: number; archived: number; worktreesMissing: WorktreeCheck[] }
  agentSessions: { orphaned: number }
  integrations: {
    notion: { configured: boolean }
    sentry: { configured: boolean }
    editor: { configured: boolean }
  }
}

const report = ref<HealthReport | null>(null)
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    const res = await fetch('/api/health/report')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    report.value = (await res.json()) as HealthReport
  } catch (err) {
    $q.notify({ type: 'negative', message: String(err), position: 'top', timeout: 4000 })
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

const dbSizeHuman = computed(() => {
  const b = report.value?.db.sizeBytes
  if (b === null || b === undefined) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
})

const dbSchemaOk = computed(() => {
  const r = report.value
  return r ? r.db.schemaVersion === r.db.currentSchemaVersion : false
})

function statusIcon(ok: boolean) {
  return ok ? 'check_circle' : 'error'
}

function statusColor(ok: boolean) {
  return ok ? 'positive' : 'negative'
}
</script>

<template>
  <q-page class="q-pa-md" style="max-width: 900px; margin: 0 auto;">
    <div class="row items-center q-mb-md">
      <q-btn flat dense round icon="arrow_back" @click="router.back()" />
      <div class="text-h6 q-ml-sm">{{ $t('health.title') }}</div>
      <q-space />
      <q-btn flat dense icon="refresh" :loading="loading" :label="$t('common.refresh')" @click="refresh" />
    </div>

    <div v-if="!report && loading" class="text-grey-6 text-center q-pa-lg">{{ $t('common.loading') }}</div>

    <div v-else-if="report" class="column q-gutter-md">
      <!-- Kōbō home -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="text-subtitle2 q-mb-sm">{{ $t('health.envTitle') }}</div>
          <div class="text-caption text-grey-6">{{ $t('health.koboHome') }}</div>
          <div class="text-body2">{{ report.koboHome }}</div>
        </q-card-section>
      </q-card>

      <!-- Database -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <div class="text-subtitle2">{{ $t('health.dbTitle') }}</div>
            <q-space />
            <q-icon :name="statusIcon(dbSchemaOk)" :color="statusColor(dbSchemaOk)" />
          </div>
          <div class="row q-col-gutter-md q-mt-xs">
            <div class="col">
              <div class="text-caption text-grey-6">{{ $t('health.dbPath') }}</div>
              <div class="text-body2">{{ report.db.path }}</div>
            </div>
            <div class="col-auto">
              <div class="text-caption text-grey-6">{{ $t('health.dbSize') }}</div>
              <div class="text-body2">{{ dbSizeHuman }}</div>
            </div>
            <div class="col-auto">
              <div class="text-caption text-grey-6">{{ $t('health.schemaVersion') }}</div>
              <div class="text-body2">{{ report.db.schemaVersion }} / {{ report.db.currentSchemaVersion }}</div>
            </div>
          </div>
        </q-card-section>
      </q-card>

      <!-- Claude CLI -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <div class="text-subtitle2">{{ $t('health.cliTitle') }}</div>
            <q-space />
            <q-icon :name="statusIcon(report.claudeCli.available)" :color="statusColor(report.claudeCli.available)" />
          </div>
          <div v-if="report.claudeCli.available" class="text-caption text-grey-5 q-mt-xs">
            {{ report.claudeCli.version }}
          </div>
          <div v-else class="text-caption text-negative q-mt-xs">
            {{ $t('health.cliMissing') }}
          </div>
        </q-card-section>
      </q-card>

      <!-- Workspaces -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <div class="text-subtitle2">{{ $t('health.workspacesTitle') }}</div>
            <q-space />
            <q-icon
              :name="statusIcon(report.workspaces.worktreesMissing.length === 0)"
              :color="statusColor(report.workspaces.worktreesMissing.length === 0)"
            />
          </div>
          <div class="text-caption text-grey-6 q-mt-xs">
            {{ $t('health.workspacesCount', { total: report.workspaces.total, archived: report.workspaces.archived }) }}
          </div>
          <div v-if="report.workspaces.worktreesMissing.length > 0" class="q-mt-sm">
            <div class="text-caption text-negative q-mb-xs">
              {{ $t('health.worktreesMissing', { count: report.workspaces.worktreesMissing.length }) }}
            </div>
            <q-list dense dark>
              <q-item v-for="w in report.workspaces.worktreesMissing" :key="w.workspaceId">
                <q-item-section>
                  <div class="text-body2">{{ w.name }}</div>
                  <div class="text-caption text-grey-6">{{ w.path }}</div>
                </q-item-section>
              </q-item>
            </q-list>
          </div>
        </q-card-section>
      </q-card>

      <!-- Agent sessions -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <div class="text-subtitle2">{{ $t('health.sessionsTitle') }}</div>
            <q-space />
            <q-icon
              :name="statusIcon(report.agentSessions.orphaned === 0)"
              :color="statusColor(report.agentSessions.orphaned === 0)"
            />
          </div>
          <div class="text-caption q-mt-xs" :class="report.agentSessions.orphaned > 0 ? 'text-negative' : 'text-grey-6'">
            {{ $t('health.sessionsOrphaned', { n: report.agentSessions.orphaned }) }}
          </div>
        </q-card-section>
      </q-card>

      <!-- Integrations -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="text-subtitle2 q-mb-sm">{{ $t('health.integrationsTitle') }}</div>
          <div class="column q-gutter-xs">
            <div class="row items-center">
              <q-icon :name="statusIcon(report.integrations.notion.configured)" :color="statusColor(report.integrations.notion.configured)" size="sm" />
              <span class="q-ml-sm text-body2">Notion</span>
              <span class="q-ml-sm text-caption text-grey-6">
                {{ report.integrations.notion.configured ? $t('health.integrationConfigured') : $t('health.integrationMissing') }}
              </span>
            </div>
            <div class="row items-center">
              <q-icon :name="statusIcon(report.integrations.sentry.configured)" :color="statusColor(report.integrations.sentry.configured)" size="sm" />
              <span class="q-ml-sm text-body2">Sentry</span>
              <span class="q-ml-sm text-caption text-grey-6">
                {{ report.integrations.sentry.configured ? $t('health.integrationConfigured') : $t('health.integrationMissing') }}
              </span>
            </div>
            <div class="row items-center">
              <q-icon :name="statusIcon(report.integrations.editor.configured)" :color="statusColor(report.integrations.editor.configured)" size="sm" />
              <span class="q-ml-sm text-body2">Editor</span>
              <span class="q-ml-sm text-caption text-grey-6">
                {{ report.integrations.editor.configured ? $t('health.integrationConfigured') : $t('health.integrationMissing') }}
              </span>
            </div>
          </div>
        </q-card-section>
      </q-card>
    </div>
  </q-page>
</template>
