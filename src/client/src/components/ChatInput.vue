<script setup lang="ts">
import { useWebSocketStore } from 'src/stores/websocket'
import { useWorkspaceStore } from 'src/stores/workspace'
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  workspaceId: string
}>()

const store = useWorkspaceStore()
const wsStore = useWebSocketStore()
const message = ref('')

// Skills autocomplete
const skills = ref<string[]>([])
const showSkills = ref(false)
const skillFilter = ref('')
const selectedSkillIndex = ref(0)

const filteredSkills = computed(() => {
  if (!skillFilter.value) return skills.value
  const q = skillFilter.value.toLowerCase()
  return skills.value.filter((s) => s.toLowerCase().includes(q))
})

let lastSkillsFetch = 0

async function fetchSkills() {
  const now = Date.now()
  if (now - lastSkillsFetch < 5000) return
  lastSkillsFetch = now
  try {
    const res = await fetch('/api/skills')
    if (res.ok) skills.value = await res.json()
  } catch {
    /* ignore */
  }
}

onMounted(fetchSkills)

// Watch for / prefix to trigger autocomplete
watch(message, async (val) => {
  if (val.startsWith('/')) {
    await fetchSkills()
    skillFilter.value = val.substring(1)
    showSkills.value = true
    selectedSkillIndex.value = 0
  } else {
    showSkills.value = false
  }
})

function selectSkill(skill: string) {
  message.value = `/${skill} `
  showSkills.value = false
}

const isDisabled = computed(() => {
  return !props.workspaceId
})

function sendMessage() {
  const text = message.value.trim()
  if (!text || isDisabled.value) return

  wsStore.sendChatMessage(props.workspaceId, text)

  store.addActivityItem(props.workspaceId, {
    id: `user-${Date.now()}`,
    type: 'text',
    content: text,
    timestamp: new Date().toISOString(),
    meta: { sender: 'user', pending: true },
  })

  message.value = ''
}

function onKeydown(event: KeyboardEvent) {
  if (showSkills.value && filteredSkills.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selectedSkillIndex.value = Math.min(selectedSkillIndex.value + 1, filteredSkills.value.length - 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      selectedSkillIndex.value = Math.max(selectedSkillIndex.value - 1, 0)
      return
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      selectSkill(filteredSkills.value[selectedSkillIndex.value])
      return
    }
    if (event.key === 'Escape') {
      showSkills.value = false
      return
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}
</script>

<template>
  <div class="chat-input-container row items-end q-pa-sm q-gutter-sm" style="position: relative;">
    <!-- Skills autocomplete popup -->
    <div v-if="showSkills && filteredSkills.length > 0" class="skills-popup rounded-borders">
      <div class="skills-header text-caption text-weight-bold text-grey-6 q-px-sm q-py-xs">
        Skills
      </div>
      <div
        v-for="(skill, idx) in filteredSkills.slice(0, 12)"
        :key="skill"
        class="skill-item row items-center q-px-sm q-py-xs cursor-pointer"
        :class="{ 'skill-item--active': idx === selectedSkillIndex }"
        @click="selectSkill(skill)"
        @mouseenter="selectedSkillIndex = idx"
      >
        <q-icon name="bolt" size="12px" color="indigo-4" class="q-mr-xs" />
        <span class="text-caption">{{ skill }}</span>
      </div>
    </div>

    <q-input
      v-model="message"
      dense
      dark
      borderless
      autogrow
      placeholder="Message... (/ for skills)"
      class="chat-input col rounded-borders"
      :disable="isDisabled"
      @keydown="onKeydown"
    />
    <q-btn
      flat
      dense
      icon="send"
      color="primary"
      :disable="isDisabled || !message.trim()"
      @click="sendMessage"
    />
  </div>
</template>

<style lang="scss" scoped>
.chat-input-container {
  background-color: #16162a;
  border-top: 1px solid #2a2a4a;
  min-height: 48px;
}

.chat-input {
  background-color: #222244;
  padding: 4px 12px;

  :deep(.q-field__control) {
    min-height: 32px;
  }
  :deep(textarea),
  :deep(input) {
    color: #ccc;
    font-size: 13px;
  }
}

.skills-popup {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 8px;
  right: 48px;
  max-height: 300px;
  overflow-y: auto;
  background-color: #1e1e3a;
  border: 1px solid #2a2a4a;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  z-index: 9999;
}

.skills-header {
  border-bottom: 1px solid #2a2a4a;
}

.skill-item {
  font-family: 'Roboto Mono', monospace;

  &:hover,
  &--active {
    background-color: rgba(108, 99, 255, 0.15);
  }
}
</style>
