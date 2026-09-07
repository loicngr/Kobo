<template>
  <div v-if="members.length > 0" class="comparison-panel q-pa-md">
    <div class="row items-center q-mb-sm">
      <div class="text-subtitle2">{{ $t('comparison.title') }}</div>
      <q-space />
      <q-btn flat dense round size="sm" icon="refresh" :loading="loading" @click="load" />
    </div>
    <div class="text-caption text-kobo-3 q-mb-sm">{{ $t('comparison.hint') }}</div>

    <q-markup-table flat dense dark class="comparison-table">
      <thead>
        <tr>
          <th class="text-left">{{ $t('comparison.engine') }}</th>
          <th class="text-left">{{ $t('comparison.status') }}</th>
          <th class="text-right">{{ $t('comparison.commits') }}</th>
          <th class="text-right">{{ $t('comparison.files') }}</th>
          <th class="text-right">{{ $t('comparison.diff') }}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="member in members" :key="member.workspace.id" :class="{ 'comparison-current': isCurrent(member) }">
          <td>
            <div>{{ engineLabel(member.workspace.engine) }}</div>
            <div class="text-caption text-kobo-3 comparison-mono">{{ member.workspace.model }}</div>
          </td>
          <td>
            {{ statusLabel(member.workspace.status) }}
            <span v-if="member.workspace.archivedAt" class="text-caption text-kobo-3">
              · {{ $t('comparison.archived') }}
            </span>
          </td>
          <td class="text-right">{{ member.gitStats?.commitCount ?? '-' }}</td>
          <td class="text-right">{{ member.gitStats?.filesChanged ?? '-' }}</td>
          <td class="text-right">
            <span v-if="member.gitStats" class="comparison-mono">
              <span class="text-kobo-success">+{{ member.gitStats.insertions }}</span>
              <span class="text-kobo-danger q-ml-xs">-{{ member.gitStats.deletions }}</span>
            </span>
            <span v-else class="text-kobo-3">-</span>
          </td>
          <td class="text-right">
            <q-btn
              v-if="!isCurrent(member)"
              flat
              dense
              no-caps
              size="sm"
              :label="$t('comparison.open')"
              @click="open(member.workspace.id)"
            />
            <span v-else class="text-caption text-kobo-3">{{ $t('comparison.current') }}</span>
          </td>
        </tr>
      </tbody>
    </q-markup-table>

    <div v-if="members.length < 2" class="text-caption text-kobo-warning q-mt-sm">
      {{ $t('comparison.incomplete') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore, type Workspace } from 'src/stores/workspace'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const props = defineProps<{ workspaceId: string }>()

interface GitStats {
  commitCount: number
  filesChanged: number
  insertions: number
  deletions: number
}

interface ComparisonMember {
  workspace: Workspace
  gitStats: GitStats | null
}

const router = useRouter()
const store = useWorkspaceStore()
const { t } = useI18n()

const members = ref<ComparisonMember[]>([])
const loading = ref(false)

/** Reuses the drawer's own status wording rather than inventing a second one. */
const STATUS_LABEL_KEYS: Record<string, string> = {
  created: 'workspaceStatus.created',
  extracting: 'workspaceStatus.extracting',
  brainstorming: 'workspaceStatus.brainstorming',
  executing: 'workspaceStatus.executing',
  'awaiting-user': 'workspaceStatus.awaitingUser',
  completed: 'workspaceStatus.completed',
  idle: 'workspaceStatus.idle',
  error: 'workspaceStatus.error',
  quota: 'workspaceStatus.quota',
  retrying: 'workspaceStatus.retrying',
}

/** Display names from `/api/engines`, falling back to the raw id until loaded. */
const engineNames = ref<Record<string, string>>({})

function engineLabel(id: string): string {
  return engineNames.value[id] ?? id
}

async function loadEngineNames(): Promise<void> {
  try {
    const res = await fetch('/api/engines')
    if (!res.ok) return
    const engines = (await res.json()) as Array<{ id: string; displayName: string }>
    engineNames.value = Object.fromEntries(engines.map((e) => [e.id, e.displayName]))
  } catch {
    // Ids are readable enough on their own; a failed lookup costs nothing.
  }
}

function statusLabel(status: string): string {
  const key = STATUS_LABEL_KEYS[status]
  return key ? t(key) : status
}

const currentId = computed(() => props.workspaceId)

function isCurrent(member: ComparisonMember): boolean {
  return member.workspace.id === currentId.value
}

function open(id: string): void {
  store.selectWorkspace(id)
  void router.push({ name: 'workspace', params: { id } })
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspaceId}/comparison`)
    if (!res.ok) {
      members.value = []
      return
    }
    const body = (await res.json()) as { members?: ComparisonMember[] }
    members.value = body.members ?? []
  } catch {
    // A panel that only reports: a failure here must not disturb the Git tab
    // it sits above.
    members.value = []
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadEngineNames()
  void load()
})
watch(() => props.workspaceId, load)
</script>

<style lang="scss" scoped>
.comparison-panel {
  border-bottom: 1px solid var(--kobo-border);
}

.comparison-table {
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border);
  border-radius: var(--kobo-radius-md);
}

.comparison-current {
  background: var(--kobo-surface-2);
}

.comparison-mono {
  font-family: var(--kobo-font-mono);
}
</style>
