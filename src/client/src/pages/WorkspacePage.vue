<script setup lang="ts">
import type { AgentSession } from 'src/stores/workspace'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, defineAsyncComponent, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const ActivityFeed = defineAsyncComponent(() =>
  Promise.all([import('src/components/ActivityFeed.vue'), new Promise((resolve) => setTimeout(resolve, 500))]).then(
    ([module]) => module,
  ),
)

import ChatInput from 'src/components/ChatInput.vue'

const store = useWorkspaceStore()
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
    label: `Session #${store.sessions.length - idx}`,
    value: s.claudeSessionId,
    caption: timeAgo(s.startedAt),
  }))
  return [{ label: 'All sessions', value: null, caption: '' }, ...opts]
})

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
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
        <q-btn
          v-if="['created', 'idle', 'completed', 'error', 'quota'].includes(selectedWs.status)"
          dense
          no-caps
          size="sm"
          color="positive"
          icon="play_arrow"
          label="Start"
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
          label="Stop"
          class="q-mr-xs"
          @click="store.stopWorkspace(selectedWs.id)"
        />
      </template>
      <template v-else>
        <span class="text-body2 text-grey-8">
          Select a workspace to begin
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
          <div class="text-grey-6 text-caption q-mt-sm">Loading...</div>
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
