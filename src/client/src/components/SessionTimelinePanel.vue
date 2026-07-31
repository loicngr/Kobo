<template>
  <div class="q-pa-sm">
    <div class="row items-center q-mb-sm">
      <span class="text-subtitle2">{{ $t('timeline.title') }}</span>
      <q-space />
      <q-btn flat dense round icon="download" :aria-label="$t('timeline.export')" @click="download" />
    </div>
    <q-list dark dense>
      <q-item v-for="session in sessions" :key="session.id" clickable @click="select(session.id)">
        <q-item-section>
          <q-item-label>{{ session.name || session.model || $t('timeline.unnamed') }}</q-item-label>
          <q-item-label caption>{{ session.status }} · {{ duration(session) }}</q-item-label>
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup lang="ts">
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed } from 'vue'

const props = defineProps<{ workspaceId: string }>()
const store = useWorkspaceStore()
const sessions = computed(() => store.sessions)
function select(id: string) {
  store.selectSession(id)
}
function duration(session: { startedAt: string; endedAt: string | null }) {
  const end = session.endedAt ? new Date(session.endedAt).getTime() : Date.now()
  const ms = Math.max(0, end - new Date(session.startedAt).getTime())
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}
async function download() {
  const response = await fetch(`/api/workspaces/${props.workspaceId}/diagnostic.json`)
  if (!response.ok) return
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = 'kobo-diagnostic.json'
  link.click()
  URL.revokeObjectURL(url)
}
</script>
