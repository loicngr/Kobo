<template>
  <q-item v-if="section !== 'session'">
    <q-item-section @click.stop>
      <AutoLoopChip />
    </q-item-section>
  </q-item>
  <q-item v-if="section === 'session'">
    <q-item-section @click.stop>
      <q-select
        :label="$t('reliability.sessions')"
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
        style="min-width: 160px; font-size: 11px;"
      >
        <template #option="scope">
          <q-separator v-if="!scope.opt.isSession" spaced />
          <q-item v-bind="scope.itemProps" clickable dense class="row items-center no-wrap">
            <q-item-section>
              <q-item-label :class="!scope.opt.isSession ? 'text-kobo-2' : ''">
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
                color="kobo-3"
                @click.stop
              >
                <q-menu auto-close>
                  <q-list dense>
                    <q-item clickable @click="emit('rename', scope.opt.value, scope.opt.label)">
                      <q-item-section avatar><q-icon name="edit" size="16px" /></q-item-section>
                      <q-item-section>{{ $t('workspacePage.renameSession') }}</q-item-section>
                    </q-item>
                    <q-item clickable @click="emit('copySessionId', scope.opt.value)">
                      <q-item-section avatar><q-icon name="content_copy" size="16px" /></q-item-section>
                      <q-item-section>{{ $t('workspacePage.copySessionId') }}</q-item-section>
                    </q-item>
                    <q-item
                      v-if="canDeleteSession(scope.opt.value)"
                      clickable
                      class="text-negative"
                      @click="emit('deleteSession', scope.opt.value)"
                    >
                      <q-item-section avatar><q-icon name="delete_outline" size="16px" /></q-item-section>
                      <q-item-section>{{ $t('workspacePage.deleteSession') }}</q-item-section>
                    </q-item>
                  </q-list>
                </q-menu>
              </q-btn>
            </q-item-section>
          </q-item>
        </template>
      </q-select>
    </q-item-section>
  </q-item>
  <q-item v-if="section !== 'session'">
    <q-item-section @click.stop>
      <q-select
        :label="$t('workspacePage.permissions')"
        v-model="permissionMode"
        :options="permissionModeOptions"
        emit-value
        map-options
        dense
        dark
        borderless
        options-dense
        style="min-width: 160px; font-size: 11px;"
      >
        <template #selected>
          <span class="row items-center no-wrap text-caption text-kobo-2">
            <q-icon :name="permissionModeIcon" size="12px" color="amber-6" class="q-mr-xs" />
            {{ permissionModeLabel }}
            <q-icon v-if="pendingSpawnChanges.has('agentPermissionMode')" name="schedule" size="11px" color="orange-6" class="q-ml-xs">
              <q-tooltip>{{ $t('workspacePage.pendingNextRun') }}</q-tooltip>
            </q-icon>
          </span>
        </template>
      </q-select>
    </q-item-section>
  </q-item>
  <q-item v-if="section !== 'session'">
    <q-item-section @click.stop>
      <q-select
        :label="$t('engine.model')"
        v-model="model"
        :options="modelOptions"
        emit-value
        map-options
        dense
        dark
        borderless
        options-dense
        class="model-select"
        style="min-width: 160px; font-size: 11px;"
      >
        <template #selected>
          <span class="row items-center no-wrap text-caption text-kobo-2">
            <q-icon name="auto_awesome" size="12px" color="primary" class="q-mr-xs" />
            {{ modelLabel }}
            <q-icon v-if="pendingSpawnChanges.has('model')" name="schedule" size="11px" color="orange-6" class="q-ml-xs">
              <q-tooltip>{{ $t('workspacePage.pendingNextRun') }}</q-tooltip>
            </q-icon>
          </span>
        </template>
      </q-select>
    </q-item-section>
  </q-item>
  <q-item v-if="section !== 'session'">
    <q-item-section @click.stop>
      <q-select
        :label="$t('engine.effort')"
        v-model="reasoningEffort"
        :options="reasoningOptions"
        emit-value
        map-options
        dense
        dark
        borderless
        options-dense
        style="min-width: 160px; font-size: 11px;"
      >
        <template #selected>
          <span class="row items-center no-wrap text-caption text-kobo-2">
            <q-icon name="psychology" size="12px" color="amber-6" class="q-mr-xs" />
            {{ reasoningLabel }}
            <q-icon v-if="pendingSpawnChanges.has('reasoningEffort')" name="schedule" size="11px" color="orange-6" class="q-ml-xs">
              <q-tooltip>{{ $t('workspacePage.pendingNextRun') }}</q-tooltip>
            </q-icon>
          </span>
        </template>
      </q-select>
    </q-item-section>
  </q-item>
</template>

<script setup lang="ts">
import AutoLoopChip from 'src/components/AutoLoopChip.vue'
import type { AgentSession } from 'src/stores/workspace'
import { computed } from 'vue'

type AgentPermissionModeValue = 'plan' | 'bypass' | 'strict' | 'interactive'
type SpawnField = 'model' | 'reasoningEffort' | 'agentPermissionMode'

interface SelectOption {
  label: string
  value: string
  disable?: boolean
}

interface SessionOption {
  label: string
  value: string
  caption: string
  isSession: boolean
}

const props = defineProps<{
  section: 'session' | 'configuration'
  sessions: AgentSession[]
  sessionOptions: SessionOption[]
  permissionModeOptions: SelectOption[]
  modelOptions: SelectOption[]
  reasoningOptions: SelectOption[]
  pendingSpawnChanges: Set<SpawnField>
  creatingSession: boolean
  canDeleteSession: (sessionId: string) => boolean
}>()

const emit = defineEmits<{
  rename: [sessionId: string, label: string]
  copySessionId: [sessionId: string]
  deleteSession: [sessionId: string]
}>()

const selectedSessionId = defineModel<string | null>('selectedSessionId')
const permissionMode = defineModel<AgentPermissionModeValue>('permissionMode', { required: true })
const model = defineModel<string>('model', { required: true })
const reasoningEffort = defineModel<string>('reasoningEffort', { required: true })

const permissionModeIcon = computed(() => {
  const val = permissionMode.value
  return val === 'plan' ? 'visibility' : val === 'strict' ? 'lock' : val === 'interactive' ? 'security' : 'flash_on'
})

const permissionModeLabel = computed(
  () => props.permissionModeOptions.find((m) => m.value === permissionMode.value)?.label ?? permissionMode.value,
)

const modelLabel = computed(() => props.modelOptions.find((m) => m.value === model.value)?.label ?? model.value)

const reasoningLabel = computed(
  () => props.reasoningOptions.find((r) => r.value === reasoningEffort.value)?.label ?? reasoningEffort.value,
)
</script>
