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
          <div class="row q-col-gutter-md">
            <div class="col-auto">
              <div class="text-caption text-grey-6">{{ $t('health.version') }}</div>
              <div class="text-body2" style="font-family: var(--kobo-font-mono, monospace);">
                {{ report.version }}
              </div>
            </div>
            <div class="col-auto">
              <div class="text-caption text-grey-6">{{ $t('health.settingsSchemaVersion') }}</div>
              <div class="text-body2" style="font-family: var(--kobo-font-mono, monospace);">
                {{ report.settings.schemaVersion }}
              </div>
            </div>
            <div class="col">
              <div class="text-caption text-grey-6">{{ $t('health.koboHome') }}</div>
              <div class="text-body2">{{ report.koboHome }}</div>
            </div>
          </div>
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

      <!-- Agent runtimes (Claude + Codex) -->
      <q-card dark flat bordered>
        <q-card-section>
          <div class="text-subtitle2 q-mb-sm">{{ $t('health.runtimesTitle') }}</div>
          <div class="column q-gutter-sm">
            <div class="row items-center">
              <q-icon
                :name="statusIcon(report.claudeCli.available)"
                :color="statusColor(report.claudeCli.available)"
                size="sm"
              />
              <span class="q-ml-sm text-body2">{{ $t('health.claudeCliTitle') }}</span>
              <q-space />
              <span v-if="report.claudeCli.available" class="text-caption text-grey-5">
                {{ report.claudeCli.version }}
              </span>
              <span v-else class="text-caption text-negative">
                {{ $t('health.claudeCliMissing') }}
              </span>
            </div>
            <div class="row items-center">
              <q-icon
                :name="statusIcon(report.codexCli.available)"
                :color="statusColor(report.codexCli.available)"
                size="sm"
              />
              <span class="q-ml-sm text-body2">{{ $t('health.codexCliTitle') }}</span>
              <q-space />
              <span v-if="report.codexCli.available" class="text-caption text-grey-5">
                {{ report.codexCli.version }}
              </span>
              <span v-else class="text-caption text-negative">
                {{ $t('health.codexCliMissing') }}
              </span>
            </div>
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

      <!-- Active state — quota backoffs, wakeups, auto-loops, sessions, dev servers -->
      <div class="text-subtitle1 q-mt-md q-mb-xs text-grey-5">{{ $t('health.activeTitle') }}</div>

      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <q-icon name="hourglass_top" size="sm" color="amber-6" class="q-mr-sm" />
            <div class="text-subtitle2">{{ $t('health.activeQuotaBackoffs') }}</div>
            <q-space />
            <q-badge :label="report.active.quotaBackoffs.length" color="grey-8" text-color="grey-3" />
          </div>
          <div v-if="report.active.quotaBackoffs.length === 0" class="text-caption text-grey-7 q-mt-xs">
            {{ $t('health.noneActive') }}
          </div>
          <q-list v-else dense dark class="q-mt-xs">
            <q-item
              v-for="row in report.active.quotaBackoffs"
              :key="row.workspaceId"
              clickable
              @click="goToWorkspace(row.workspaceId)"
            >
              <q-item-section>
                <div class="text-body2">{{ row.name }}</div>
                <div class="text-caption text-grey-6">
                  {{ $t('health.quotaResumeAt', { time: formatTime(row.targetAt) }) }}
                  · {{ row.source }} · retry #{{ row.retryCount }}
                </div>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <q-icon name="schedule" size="sm" color="indigo-4" class="q-mr-sm" />
            <div class="text-subtitle2">{{ $t('health.activeWakeups') }}</div>
            <q-space />
            <q-badge :label="report.active.pendingWakeups.length" color="grey-8" text-color="grey-3" />
          </div>
          <div v-if="report.active.pendingWakeups.length === 0" class="text-caption text-grey-7 q-mt-xs">
            {{ $t('health.noneActive') }}
          </div>
          <q-list v-else dense dark class="q-mt-xs">
            <q-item
              v-for="row in report.active.pendingWakeups"
              :key="row.workspaceId"
              clickable
              @click="goToWorkspace(row.workspaceId)"
            >
              <q-item-section>
                <div class="text-body2">{{ row.name }}</div>
                <div class="text-caption text-grey-6">
                  {{ $t('health.wakeupAt', { time: formatTime(row.targetAt) }) }}
                  <span v-if="row.reason"> · {{ row.reason }}</span>
                </div>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <q-icon name="autorenew" size="sm" color="amber-7" class="q-mr-sm" />
            <div class="text-subtitle2">{{ $t('health.activeAutoLoop') }}</div>
            <q-space />
            <q-badge :label="report.active.autoLoopActive.length" color="grey-8" text-color="grey-3" />
          </div>
          <div v-if="report.active.autoLoopActive.length === 0" class="text-caption text-grey-7 q-mt-xs">
            {{ $t('health.noneActive') }}
          </div>
          <q-list v-else dense dark class="q-mt-xs">
            <q-item
              v-for="row in report.active.autoLoopActive"
              :key="row.workspaceId"
              clickable
              @click="goToWorkspace(row.workspaceId)"
            >
              <q-item-section>
                <div class="text-body2">{{ row.name }}</div>
                <div class="text-caption text-grey-6">
                  {{ row.ready ? $t('health.autoLoopReady') : $t('health.autoLoopGrooming') }}
                </div>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <q-icon name="play_arrow" size="sm" color="green-5" class="q-mr-sm" />
            <div class="text-subtitle2">{{ $t('health.activeAgentSessions') }}</div>
            <q-space />
            <q-badge :label="report.active.agentSessionsAlive.length" color="grey-8" text-color="grey-3" />
          </div>
          <div v-if="report.active.agentSessionsAlive.length === 0" class="text-caption text-grey-7 q-mt-xs">
            {{ $t('health.noneActive') }}
          </div>
          <q-list v-else dense dark class="q-mt-xs">
            <q-item
              v-for="row in report.active.agentSessionsAlive"
              :key="`${row.workspaceId}-${row.pid}`"
              clickable
              @click="goToWorkspace(row.workspaceId)"
            >
              <q-item-section>
                <div class="text-body2">{{ row.workspaceName }}</div>
                <div class="text-caption text-grey-6">
                  pid {{ row.pid }} · {{ $t('health.startedAgo', { time: formatRelative(row.startedAt) }) }}
                </div>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>

      <q-card dark flat bordered>
        <q-card-section>
          <div class="row items-center">
            <q-icon name="dns" size="sm" color="cyan-5" class="q-mr-sm" />
            <div class="text-subtitle2">{{ $t('health.activeDevServers') }}</div>
            <q-space />
            <q-badge :label="report.active.devServersRunning.length" color="grey-8" text-color="grey-3" />
          </div>
          <div v-if="report.active.devServersRunning.length === 0" class="text-caption text-grey-7 q-mt-xs">
            {{ $t('health.noneActive') }}
          </div>
          <q-list v-else dense dark class="q-mt-xs">
            <q-item
              v-for="row in report.active.devServersRunning"
              :key="row.workspaceId"
              clickable
              @click="goToWorkspace(row.workspaceId)"
            >
              <q-item-section>
                <div class="text-body2">{{ row.name }}</div>
              </q-item-section>
            </q-item>
          </q-list>
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

interface QuotaBackoffRow {
  workspaceId: string
  name: string
  targetAt: string
  resetsAt: string | null
  source: string
  retryCount: number
}

interface PendingWakeupRow {
  workspaceId: string
  name: string
  targetAt: string
  reason: string | null
}

interface AutoLoopRow {
  workspaceId: string
  name: string
  ready: boolean
}

interface AgentSessionAliveRow {
  workspaceId: string
  workspaceName: string
  pid: number
  startedAt: string
}

interface DevServerRunningRow {
  workspaceId: string
  name: string
}

interface HealthReport {
  version: string
  koboHome: string
  db: { path: string; sizeBytes: number | null; schemaVersion: number; currentSchemaVersion: number }
  settings: { schemaVersion: number }
  claudeCli: { available: boolean; version: string | null }
  codexCli: { available: boolean; version: string | null }
  workspaces: { total: number; archived: number; worktreesMissing: WorktreeCheck[] }
  agentSessions: { orphaned: number }
  integrations: {
    notion: { configured: boolean }
    sentry: { configured: boolean }
    editor: { configured: boolean }
  }
  active: {
    quotaBackoffs: QuotaBackoffRow[]
    pendingWakeups: PendingWakeupRow[]
    autoLoopActive: AutoLoopRow[]
    agentSessionsAlive: AgentSessionAliveRow[]
    devServersRunning: DevServerRunningRow[]
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatRelative(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(deltaMs) || deltaMs < 0) return '—'
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function goToWorkspace(id: string): void {
  router.push({ name: 'workspace', params: { id } }).catch(() => {})
}
</script>
