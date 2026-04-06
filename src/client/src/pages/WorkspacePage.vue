<script setup lang="ts">
import type { AgentSession } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, defineAsyncComponent, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const ActivityFeed = defineAsyncComponent(() =>
  Promise.all([import('src/components/ActivityFeed.vue'), new Promise((resolve) => setTimeout(resolve, 500))]).then(
    ([module]) => module,
  ),
)

import ChatInput from 'src/components/ChatInput.vue'

const { t } = useI18n()
const store = useWorkspaceStore()

const modelOptions = [
  { label: 'Auto', value: 'auto' },
  { label: 'Opus 4.6', value: 'claude-opus-4-6' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
]

const permissionModeOptions = computed(() => [
  { label: t('workspace.permissionAutoAccept'), value: 'auto-accept' },
  { label: t('workspace.permissionPlan'), value: 'plan' },
])

const currentModel = computed({
  get: () => store.selectedWorkspace?.model ?? 'auto',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      store.updateModel(store.selectedWorkspaceId, val)
    }
  },
})

const currentPermissionMode = computed({
  get: () => store.selectedWorkspace?.permissionMode ?? 'auto-accept',
  set: (val: string) => {
    if (store.selectedWorkspaceId) {
      store.updatePermissionMode(store.selectedWorkspaceId, val)
    }
  },
})
const route = useRoute()
const router = useRouter()

const selectedId = computed(() => store.selectedWorkspaceId)
const selectedWs = computed(() => store.selectedWorkspace)

const sessions = computed(() => store.sessions)
const selectedSessionId = computed({
  get: () => store.selectedSessionId,
  set: (val: string | null) => {
    store.selectSession(val)
    const query = { ...route.query }
    if (val) {
      query.session = val
    } else {
      delete query.session
    }
    router.replace({ query })
  },
})

const sessionOptions = computed(() => {
  const opts = store.sessions.map((s: AgentSession, idx: number) => ({
    label: t('workspace.session', { n: store.sessions.length - idx }),
    value: s.claudeSessionId,
    caption: timeAgo(s.startedAt),
  }))
  return [{ label: t('workspace.allSessions'), value: null, caption: '' }, ...opts]
})

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return t('common.justNow')
  if (min < 60) return t('common.minutesAgo', { n: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('common.hoursAgo', { n: h })
  return t('common.daysAgo', { n: Math.floor(h / 24) })
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
        <span class="text-body1 text-weight-medium text-grey-3 ellipsis">
          {{ selectedWs.name }}
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
          class="q-ml-sm"
          style="min-width: 160px; max-width: 220px; font-size: 11px;"
        />
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
        <q-btn
          v-if="['created', 'idle', 'completed', 'error', 'quota'].includes(selectedWs.status)"
          dense
          no-caps
          size="sm"
          color="positive"
          icon="play_arrow"
          :label="t('workspace.start')"
          class="q-mr-xs"
          @click="store.startWorkspace(selectedWs.id)"
        />
        <q-btn
          v-if="['extracting', 'brainstorming', 'executing'].includes(selectedWs.status)"
          dense
          no-caps
          size="sm"
          color="negative"
          icon="stop"
          :label="t('workspace.stop')"
          class="q-mr-xs"
          @click="store.stopWorkspace(selectedWs.id)"
        />
      </template>
      <template v-else>
        <span class="text-body2 text-grey-8">
          {{ t('workspace.selectWorkspace') }}
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
          <div class="text-grey-6 text-caption q-mt-sm">{{ t('common.loading') }}</div>
        </div>
      </template>
    </Suspense>

    <!-- Chat Input — pinned at bottom -->
    <ChatInput
      v-if="selectedId"
      :workspace-id="selectedId"
    />
  </q-page>
</template>

<style lang="scss" scoped>
.wp-header {
  min-height: 48px;
  background-color: #16162a;
  border-bottom: 1px solid #2a2a4a;
}
</style>
