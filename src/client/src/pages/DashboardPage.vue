<template>
  <q-page class="q-pa-md">
    <div class="row items-center q-mb-md">
      <div class="text-h6">{{ $t('dashboard.title') }}</div>
      <q-space />
      <div class="text-caption text-kobo-3">
        {{ $t('dashboard.count', { n: rows.length }, rows.length) }}
      </div>
      <TourReplayButton tour-id="dashboard" class="q-ml-xs" />
    </div>

    <q-banner v-if="rows.length === 0" dense class="kobo-dashboard-empty" data-tour="dash-overview">
      {{ $t('dashboard.empty') }}
    </q-banner>

    <q-markup-table v-else flat dense dark class="kobo-dashboard-table" data-tour="dash-overview">
      <thead>
        <tr>
          <th class="text-left">{{ $t('dashboard.workspace') }}</th>
          <th class="text-left">{{ $t('dashboard.status') }}</th>
          <th class="text-left">{{ $t('dashboard.attention') }}</th>
          <th class="text-left">{{ $t('dashboard.pr') }}</th>
          <th class="text-right">{{ $t('dashboard.diff') }}</th>
          <th class="text-right">{{ $t('dashboard.activity') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.workspace.id"
          class="kobo-dashboard-row"
          @click="open(row.workspace.id)"
        >
          <td>
            <div class="row items-center no-wrap">
              <q-icon
                v-if="row.workspace.favoritedAt"
                name="star"
                size="xs"
                class="q-mr-xs text-kobo-2"
              />
              <span class="ellipsis">{{ row.workspace.name }}</span>
            </div>
            <div class="text-caption text-kobo-3 ellipsis">{{ row.workspace.workingBranch }}</div>
          </td>
          <td>
            <span :class="`text-${statusColor(row.workspace.status)}`">
              {{ statusLabel(row.workspace.status) }}
            </span>
          </td>
          <td>
            <span v-if="row.reasons.length === 0" class="text-kobo-3">-</span>
            <WorkspaceAttentionLabels v-else :workspace="row.workspace" />
          </td>
          <td>
            <a
              v-if="row.stats?.prUrl"
              :href="row.stats.prUrl"
              target="_blank"
              rel="noopener"
              class="kobo-dashboard-link"
              @click.stop
            >
              {{ row.stats.prState ?? $t('dashboard.prOpen') }}
            </a>
            <span v-else class="text-kobo-3">-</span>
          </td>
          <td class="text-right">
            <span v-if="row.stats" class="kobo-dashboard-diff">
              <span class="text-kobo-success">+{{ row.stats.insertions }}</span>
              <span class="text-kobo-danger q-ml-xs">-{{ row.stats.deletions }}</span>
            </span>
            <span v-else class="text-kobo-3">-</span>
          </td>
          <td class="text-right text-kobo-3">{{ timeAgo(row.workspace.updatedAt) }}</td>
        </tr>
      </tbody>
    </q-markup-table>

    <q-card dark flat bordered class="q-mt-lg" data-tour="dash-reliability">
      <q-card-section>
        <div class="text-subtitle2">{{ $t('reliability.title') }}</div>
        <div class="text-caption text-kobo-3">{{ $t('reliability.subtitle') }}</div>
      </q-card-section>
      <q-card-section v-if="reliabilityError" class="q-pt-none text-caption text-kobo-warning">
        {{ $t('reliability.loadFailed') }}
      </q-card-section>
      <q-card-section v-else-if="reliability.length === 0" class="q-pt-none text-caption text-kobo-3">
        {{ $t('reliability.empty') }}
      </q-card-section>
      <q-markup-table v-else flat dense dark>
        <thead>
          <tr>
            <th class="text-left">{{ $t('reliability.engine') }}</th>
            <th class="text-left">{{ $t('reliability.model') }}</th>
            <th class="text-right">{{ $t('reliability.sessions') }}</th>
            <th class="text-right">{{ $t('reliability.completed') }}</th>
            <th class="text-right">{{ $t('reliability.watchdog') }}</th>
            <th class="text-right">{{ $t('reliability.killed') }}</th>
            <th class="text-right">{{ $t('reliability.errors') }}</th>
            <th class="text-right">{{ $t('reliability.unknown') }}</th>
            <th class="text-right">{{ $t('reliability.median') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in reliability" :key="`${row.engine}/${row.model}`">
            <td>{{ row.engine === 'unknown' ? $t('reliability.unknown') : row.engine }}</td>
            <td class="kobo-dashboard-diff">{{ row.model === 'unknown' ? $t('reliability.unknown') : row.model }}</td>
            <td class="text-right">{{ row.total }}</td>
            <td class="text-right" :class="`text-${ratioColor(row)}`">
              {{ formatRatio(row) }}
            </td>
            <td class="text-right">{{ row.watchdog }}</td>
            <td class="text-right">{{ row.killed }}</td>
            <td class="text-right">{{ row.error }}</td>
            <td class="text-right text-kobo-3">{{ row.unknown }}</td>
            <td class="text-right kobo-dashboard-diff">{{ formatMedian(row.medianDurationMs) }}</td>
          </tr>
        </tbody>
      </q-markup-table>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import TourReplayButton from 'src/components/TourReplayButton.vue'
import WorkspaceAttentionLabels from 'src/components/WorkspaceAttentionLabels.vue'
import { useTours } from 'src/composables/use-tours'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { getAttentionReasons } from 'src/utils/workspace-attention'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const router = useRouter()
const store = useWorkspaceStore()
const { workspaces, prSnapshots, gitStatsCache } = storeToRefs(store)
const { timeAgo } = useTimeAgo()
const { t } = useI18n()
const { scheduleAutoRun } = useTours()

/** Reuses the labels the workspace cards already show, rather than a second wording. */
const STATUS_LABEL_KEYS: Record<string, string> = {
  created: 'workspaceStatus.created',
  extracting: 'workspaceStatus.extracting',
  brainstorming: 'workspaceStatus.brainstorming',
  executing: 'workspaceStatus.executing',
  compacting: 'workspaceStatus.compacting',
  'awaiting-user': 'workspaceStatus.awaitingUser',
  completed: 'workspaceStatus.completed',
  idle: 'workspaceStatus.idle',
  error: 'workspaceStatus.error',
  quota: 'workspaceStatus.quota',
}

function statusLabel(status: string): string {
  const key = STATUS_LABEL_KEYS[status]
  return key ? t(key) : status
}

/**
 * One row per non-archived workspace, ordered so the ones asking for something
 * come first. Everything here already lives in the store, refreshed by the
 * existing bulk poll — this page adds no request of its own.
 */
const rows = computed(() =>
  workspaces.value
    .filter((workspace) => !workspace.archivedAt)
    .map((workspace) => ({
      workspace,
      stats: gitStatsCache.value[workspace.id],
      reasons: getAttentionReasons(workspace, prSnapshots.value[workspace.id]),
    }))
    .sort((a, b) => {
      if (a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length
      return b.workspace.updatedAt.localeCompare(a.workspace.updatedAt)
    }),
)

function statusColor(status: string): string {
  if (status === 'error' || status === 'quota') return 'kobo-danger'
  // Not the accent: DESIGN.md keeps it for UI components, never for text.
  if (status === 'executing' || status === 'brainstorming' || status === 'extracting' || status === 'compacting')
    return 'kobo-2'
  if (status === 'awaiting-user') return 'kobo-warning'
  return 'kobo-3'
}

function open(id: string): void {
  void router.push({ name: 'workspace', params: { id } })
}

interface ReliabilityRow {
  engine: string
  model: string
  total: number
  completed: number
  error: number
  killed: number
  watchdog: number
  unknown: number
  completedRatio: number
  medianDurationMs: number | null
}

const reliability = ref<ReliabilityRow[]>([])
/** A failed fetch is not "no session ended yet" — say which one it is. */
const reliabilityError = ref(false)

/**
 * A ratio computed from a couple of sessions says nothing, so it stays grey
 * until there is enough history to mean something.
 */
function ratioColor(row: ReliabilityRow): string {
  if (row.total < 5) return 'kobo-3'
  if (row.completedRatio >= 0.8) return 'kobo-success'
  if (row.completedRatio >= 0.5) return 'kobo-warning'
  return 'kobo-danger'
}

function formatRatio(row: ReliabilityRow): string {
  return `${Math.round(row.completedRatio * 100)}%`
}

function formatMedian(ms: number | null): string {
  if (ms === null) return '-'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return t('reliability.durationSeconds', { s: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('reliability.durationMinutes', { m: minutes, s: seconds % 60 })
  return t('reliability.durationHours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

async function loadReliability(): Promise<void> {
  try {
    const res = await fetch('/api/usage/reliability')
    if (!res.ok) {
      reliabilityError.value = true
      return
    }
    const body = (await res.json()) as { engines?: ReliabilityRow[] }
    reliability.value = body.engines ?? []
    reliabilityError.value = false
  } catch {
    // Read-only extra panel: a failure here must not blank the workspace table.
    reliabilityError.value = true
  }
}

onMounted(() => {
  // The 15 s poll keeps this fresh; ask once on arrival so the page is not
  // empty for up to a full interval after a cold load.
  void store.fetchWorkspacesInfo()
  void loadReliability()
  scheduleAutoRun('dashboard')
})
</script>

<style lang="scss" scoped>
.kobo-dashboard-table {
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border);
  border-radius: var(--kobo-radius-md);
}

.kobo-dashboard-row {
  cursor: pointer;
}

.kobo-dashboard-row:hover {
  background: var(--kobo-surface-2);
}

.kobo-dashboard-empty {
  background: var(--kobo-surface-2);
  color: var(--kobo-text-2);
}

.kobo-dashboard-link {
  // DESIGN.md: the accent is never a text colour; links use text-2.
  color: var(--kobo-text-2);
  text-decoration: underline;
}

.kobo-dashboard-diff {
  font-family: var(--kobo-font-mono);
}
</style>
