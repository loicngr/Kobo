<script setup lang="ts">
import { useQuasar } from 'quasar'
import { MODEL_OPTION_DEFS } from 'src/constants/models'
import type { AgentSession } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const ActivityFeed = defineAsyncComponent(() =>
  Promise.all([import('src/components/ActivityFeed.vue'), new Promise((resolve) => setTimeout(resolve, 500))]).then(
    ([module]) => module,
  ),
)

import AgentBusyBanner from 'src/components/AgentBusyBanner.vue'
import ChatInput from 'src/components/ChatInput.vue'

const $q = useQuasar()
const store = useWorkspaceStore()
const { t } = useI18n()
const { timeAgo } = useTimeAgo()

const starting = ref(false)
const stopping = ref(false)
const pendingWorkspaceUpdates = new Set<Promise<unknown>>()

function trackWorkspaceUpdate(promise: Promise<unknown>) {
  pendingWorkspaceUpdates.add(promise)
  promise.finally(() => {
    pendingWorkspaceUpdates.delete(promise)
  })
}

async function waitForPendingWorkspaceUpdates() {
  if (pendingWorkspaceUpdates.size === 0) return
  await Promise.allSettled([...pendingWorkspaceUpdates])
}

async function handleStart() {
  if (!store.selectedWorkspaceId) return
  starting.value = true
  try {
    await waitForPendingWorkspaceUpdates()
    await store.startWorkspace(store.selectedWorkspaceId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.startFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    starting.value = false
  }
}

const interrupting = ref(false)

async function handleInterrupt() {
  if (!store.selectedWorkspaceId) return
  interrupting.value = true
  try {
    await store.interruptAgent(store.selectedWorkspaceId)
    $q.notify({ type: 'info', message: t('workspacePage.interrupted'), position: 'top', timeout: 3000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.interruptFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    interrupting.value = false
  }
}

async function handleStop() {
  if (!store.selectedWorkspaceId) return
  stopping.value = true
  try {
    await store.stopWorkspace(store.selectedWorkspaceId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : t('workspacePage.stopFailed')
    $q.notify({ type: 'negative', message: msg, position: 'top', timeout: 6000 })
  } finally {
    stopping.value = false
  }
}

const modelOptions = computed(() => [
  ...MODEL_OPTION_DEFS.map((option) => ({ label: t(option.i18nLabelKey), value: option.value })),
])

const reasoningOptions = computed(() => [
  { label: formatReasoningLabel(t('reasoning.auto')), value: 'auto' },
  { label: formatReasoningLabel(t('reasoning.low')), value: 'low' },
  { label: formatReasoningLabel(t('reasoning.medium')), value: 'medium' },
  { label: formatReasoningLabel(t('reasoning.high')), value: 'high' },
  { label: formatReasoningLabel(t('reasoning.max')), value: 'max' },
])

const permissionModeOptions = computed(() => [
  { label: t('permissionMode.autoAccept'), value: 'auto-accept' },
  { label: t('permissionMode.plan'), value: 'plan' },
])

const currentModel = computed({
  get: () => store.selectedWorkspace?.model ?? 'auto',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      trackWorkspaceUpdate(store.updateModel(store.selectedWorkspaceId, val))
    }
  },
})

const currentReasoningEffort = computed({
  get: () => store.selectedWorkspace?.reasoningEffort ?? 'auto',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      trackWorkspaceUpdate(store.updateReasoningEffort(store.selectedWorkspaceId, val))
    }
  },
})

function formatReasoningLabel(label: string): string {
  const separatorIndex = label.indexOf(':')
  if (separatorIndex >= 0) return label.slice(separatorIndex + 1).trim()
  return label
}

function formatReasoningSelectedLabel(value: string): string {
  return reasoningOptions.value.find((r) => r.value === value)?.label ?? value
}

const currentPermissionMode = computed({
  get: () => store.selectedWorkspace?.permissionMode ?? 'auto-accept',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      trackWorkspaceUpdate(store.updatePermissionMode(store.selectedWorkspaceId, val))
    }
  },
})

const currentUsage = computed(() => {
  const wid = store.selectedWorkspaceId
  if (!wid) return { inputTokens: 0, outputTokens: 0, costUsd: 0, totalTokens: 0 }
  const usage = store.usageStats[wid] ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    totalTokens: usage.inputTokens + usage.outputTokens,
  }
})

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
const route = useRoute()
const router = useRouter()

const selectedId = computed(() => store.selectedWorkspaceId)
const selectedWs = computed(() => store.selectedWorkspace)

const sessions = computed(() => store.sessions)
const selectedSessionId = computed({
  get: () => store.selectedSessionId,
  set: (val: string | null) => {
    if (val === '__new__') {
      handleCreateSession()
      return
    }
    if (!val) return
    store.selectSession(val)
    const query = { ...route.query }
    query.session = val
    router.replace({ query })
  },
})

const sessionOptions = computed(() => {
  const opts = store.sessions.map((s: AgentSession, idx: number) => ({
    label: s.name ?? t('workspacePage.session', { n: store.sessions.length - idx }),
    value: s.id,
    caption: timeAgo(s.startedAt),
    isSession: true,
  }))
  return [...opts, { label: t('workspacePage.newSession'), value: '__new__', caption: '', isSession: false }]
})

const renameDialogOpen = ref(false)
const renameTarget = ref<{ id: string } | null>(null)
const renameValue = ref('')
const creatingSession = ref(false)

function openRenameDialog(sessionId: string, currentLabel: string) {
  const session = store.sessions.find((s) => s.id === sessionId)
  if (!session) return
  renameTarget.value = { id: sessionId }
  renameValue.value = session.name ?? currentLabel
  renameDialogOpen.value = true
}

async function handleRename() {
  if (!renameTarget.value || !store.selectedWorkspaceId) return
  try {
    await store.renameSession(store.selectedWorkspaceId, renameTarget.value.id, renameValue.value.trim())
  } catch (err) {
    console.error('[WorkspacePage] renameSession failed:', err)
    $q.notify({ type: 'negative', message: t('workspacePage.renameFailed'), position: 'top' })
  } finally {
    renameDialogOpen.value = false
  }
}

async function handleCreateSession() {
  if (!store.selectedWorkspaceId) return
  creatingSession.value = true
  try {
    await store.createSession(store.selectedWorkspaceId)
  } catch (e) {
    console.error('[WorkspacePage] createSession failed:', e)
    // Prefer the server's actionable error message (e.g. "agent already running",
    // "workspace archived") falling back to a localized generic label.
    const serverMsg = e instanceof Error ? e.message : null
    $q.notify({
      type: 'negative',
      message: serverMsg ?? t('workspacePage.createSessionFailed'),
      position: 'top',
      timeout: 6000,
    })
  } finally {
    creatingSession.value = false
  }
}

onMounted(() => {
  const id = route.params.id as string | undefined
  if (id) {
    store.selectWorkspace(id)
  }
  const sessionParam = route.query.session as string | undefined
  if (sessionParam) {
    store.selectSession(sessionParam)
  }
})

watch(
  () => route.params.id,
  (newId) => {
    if (newId && newId !== store.selectedWorkspaceId) {
      store.selectWorkspace(newId as string)
    }
  },
)
</script>

<template>
  <q-page class="column no-wrap" style="height: 100vh;">
    <!-- Header bar -->
    <div class="wp-header row items-center q-px-md q-py-sm no-wrap">
      <template v-if="selectedWs">
        <span class="text-body1 text-weight-medium text-grey-3 ellipsis" style="max-width: 480px;">
          {{ selectedWs.name }}
          <q-tooltip>{{ selectedWs.name }}</q-tooltip>
        </span>
        <q-badge
          :label="selectedWs.status"
          :color="
            ['error', 'quota'].includes(selectedWs.status) ? 'red-9' :
            ['extracting', 'brainstorming', 'executing'].includes(selectedWs.status) ? 'green-9' :
            'grey-8'
          "
          class="q-ml-sm"
          style="font-size: 10px;"
        />
        <q-chip
          v-if="currentUsage.totalTokens > 0"
          dense
          color="grey-9"
          text-color="grey-3"
          class="q-ml-sm"
          style="font-size: 10px;"
        >
          <q-icon name="toll" size="12px" class="q-mr-xs" />
          <span>{{ $t('stats.tokens') }}: {{ formatTokenCount(currentUsage.totalTokens) }}</span>
          <q-tooltip>
            {{ $t('stats.inputTokens') }}: {{ formatTokenCount(currentUsage.inputTokens) }}<br>
            {{ $t('stats.outputTokens') }}: {{ formatTokenCount(currentUsage.outputTokens) }}
          </q-tooltip>
        </q-chip>
        <q-chip
          v-if="currentUsage.costUsd > 0"
          dense
          color="grey-9"
          text-color="grey-3"
          class="q-ml-xs"
          style="font-size: 10px;"
        >
          <q-icon name="attach_money" size="12px" class="q-mr-xs" />
          <span>{{ $t('stats.cost') }}: ${{ currentUsage.costUsd.toFixed(4) }}</span>
        </q-chip>
        <q-select
          v-if="sessions.length > 0"
          v-model="selectedSessionId"
          :options="sessionOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          :loading="creatingSession"
          :disable="creatingSession"
          class="q-ml-sm"
          style="min-width: 160px; max-width: 220px; font-size: 11px;"
        >
          <template #option="scope">
            <q-separator v-if="!scope.opt.isSession" spaced />
            <q-item v-bind="scope.itemProps" clickable dense class="row items-center no-wrap">
              <q-item-section>
                <q-item-label :class="!scope.opt.isSession ? 'text-grey-5' : ''">
                  {{ scope.opt.label }}
                </q-item-label>
                <q-item-label v-if="scope.opt.caption" caption>{{ scope.opt.caption }}</q-item-label>
              </q-item-section>
              <q-item-section v-if="scope.opt.isSession" side>
                <q-btn
                  icon="more_vert"
                  flat
                  dense
                  round
                  size="xs"
                  color="grey-6"
                  @click.stop="openRenameDialog(scope.opt.value, scope.opt.label)"
                />
              </q-item-section>
            </q-item>
          </template>
        </q-select>
        <q-space />
        <q-select
          v-model="currentPermissionMode"
          :options="permissionModeOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          class="q-mr-xs"
          style="min-width: 80px; max-width: 140px; font-size: 11px;"
        >
          <template #selected>
            <span class="row items-center no-wrap text-caption text-grey-5">
              <q-icon :name="currentPermissionMode === 'plan' ? 'visibility' : 'flash_on'" size="12px" color="amber-6" class="q-mr-xs" />
              {{ permissionModeOptions.find(m => m.value === currentPermissionMode)?.label ?? currentPermissionMode }}
            </span>
          </template>
        </q-select>
        <q-select
          v-model="currentModel"
          :options="modelOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          class="q-mr-sm model-select"
          style="min-width: 100px; max-width: 160px; font-size: 11px;"
        >
          <template #selected>
            <span class="row items-center no-wrap text-caption text-grey-5">
              <q-icon name="auto_awesome" size="12px" color="indigo-4" class="q-mr-xs" />
              {{ modelOptions.find(m => m.value === currentModel)?.label ?? currentModel }}
            </span>
          </template>
        </q-select>
        <q-select
          v-model="currentReasoningEffort"
          :options="reasoningOptions"
          emit-value
          map-options
          dense
          dark
          borderless
          options-dense
          class="q-mr-sm"
          style="min-width: 90px; max-width: 140px; font-size: 11px;"
        >
          <template #selected>
            <span class="row items-center no-wrap text-caption text-grey-5">
              <q-icon name="psychology" size="12px" color="amber-6" class="q-mr-xs" />
              {{ formatReasoningSelectedLabel(currentReasoningEffort) }}
            </span>
          </template>
        </q-select>
        <q-btn
          v-if="['created', 'idle', 'completed', 'error', 'quota'].includes(selectedWs.status)"
          dense
          no-caps
          size="sm"
          color="positive"
          icon="play_arrow"
          :label="$t('common.start')"
          class="q-mr-xs"
          :loading="starting"
          :disable="starting"
          @click="handleStart"
        />
        <q-btn
          v-if="['extracting', 'brainstorming', 'executing'].includes(selectedWs.status)"
          dense
          no-caps
          size="sm"
          color="negative"
          icon="stop"
          :label="$t('common.stop')"
          class="q-mr-xs"
          :loading="stopping"
          :disable="stopping"
          @click="handleStop"
        />
      </template>
      <template v-else>
        <span class="text-body2 text-grey-8">
          {{ $t('workspacePage.selectWorkspace') }}
        </span>
      </template>
    </div>

    <q-separator dark />

    <!-- Activity Feed with Suspense -->
    <Suspense>
      <ActivityFeed class="col" style="min-height: 0;" />
      <template #fallback>
        <div class="col column items-center justify-center">
          <q-spinner-dots size="40px" color="indigo-4" />
          <div class="text-grey-6 text-caption q-mt-sm">{{ $t('common.loading') }}</div>
        </div>
      </template>
    </Suspense>

    <AgentBusyBanner />

    <!-- Chat Input — pinned at bottom -->
    <ChatInput
      v-if="selectedId"
      :workspace-id="selectedId"
    />
    <q-dialog v-model="renameDialogOpen" persistent>
      <q-card dark style="min-width: 320px;">
        <q-card-section>
          <div class="text-subtitle1">{{ t('workspacePage.renameSessionTitle') }}</div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="renameValue"
            :label="t('workspacePage.sessionNameLabel')"
            dark
            dense
            autofocus
            @keyup.enter="handleRename"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat :label="t('common.cancel')" v-close-popup />
          <q-btn
            flat
            color="primary"
            :label="t('workspacePage.renameSession')"
            :disable="!renameValue.trim()"
            @click="handleRename"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<style lang="scss" scoped>
.wp-header {
  min-height: 48px;
  background-color: #16162a;
  border-bottom: 1px solid #2a2a4a;
}
</style>
