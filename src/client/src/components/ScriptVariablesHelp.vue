<template>
  <details class="script-variables text-caption q-mt-sm q-mb-sm">
    <summary class="text-kobo-3">{{ t('settings.scriptVariables.title') }}</summary>
    <p class="q-mt-sm q-mb-xs">{{ t('settings.scriptVariables.cwd') }}</p>
    <dl>
      <template v-for="[name, key] in commonVariables" :key="name">
        <dt><code>{{ name }}</code></dt>
        <dd>{{ t(`settings.scriptVariables.${key}`) }}</dd>
      </template>
      <template v-if="event">
        <dt><code>KOBO_HOOK_EVENT</code></dt>
        <dd><code>{{ event }}</code></dd>
        <dt><code>{{ eventVariables[event].join(', ') }}</code></dt>
        <dd>{{ t(`settings.scriptVariables.${event}`) }}</dd>
      </template>
    </dl>
    <p class="q-mb-xs">{{ t('settings.scriptVariables.guard') }}</p>
    <code>{{ dockerGuard }}</code>
  </details>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{ event?: 'session-ended' | 'pr-merged' | 'autoloop-disabled' | 'kobo-shutdown' }>()
const { t } = useI18n()
const commonVariables = [
  ['WORKSPACE_ID', 'workspaceId'],
  ['WORKSPACE_NAME', 'workspaceName'],
  ['BRANCH_NAME', 'branchName'],
  ['SOURCE_BRANCH', 'sourceBranch'],
  ['PROJECT_PATH', 'projectPath'],
  ['INSTANCE', 'instance'],
  ['PROJECT_NAME', 'projectName'],
] as const
const eventVariables = {
  'session-ended': [
    'KOBO_SESSION_ID',
    'KOBO_SESSION_END_REASON',
    'KOBO_SESSION_EXIT_CODE',
    'KOBO_SESSION_STOP_CAUSE',
    'KOBO_AUTOLOOP_ACTIVE',
  ],
  'pr-merged': ['KOBO_PR_NUMBER', 'KOBO_PR_URL'],
  'autoloop-disabled': ['KOBO_AUTOLOOP_REASON', 'KOBO_TASKS_PENDING'],
  'kobo-shutdown': ['KOBO_SHUTDOWN_SIGNAL'],
}
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax for the user
const dockerGuard = 'docker compose -p "${PROJECT_NAME:?Missing Docker project}" down --remove-orphans'
</script>

<style scoped>
.script-variables {
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
}
dl {
  margin: 8px 0;
}
dt {
  margin-top: 8px;
}
dd {
  margin-left: 0;
}
code {
  white-space: pre-wrap;
}
</style>
