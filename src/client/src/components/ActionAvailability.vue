<template>
  <div class="action-availability" :tabindex="reason ? 0 : undefined" :aria-describedby="reason ? descriptionId : undefined">
    <slot />
    <template v-if="reason">
      <q-tooltip>{{ reason }}</q-tooltip>
      <div :id="descriptionId" class="text-caption text-kobo-3 q-mb-sm" style="line-height: 1.4">
        {{ reason }}
        <router-link v-if="settings" :to="{ path: '/settings', query: settingsTab ? { tab: settingsTab } : undefined }" class="availability-link">{{ $t('blockers.settings') }}</router-link>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'

defineProps<{ reason: string | null; settings?: boolean; settingsTab?: string }>()
const descriptionId = useId()
</script>

<style scoped>
.action-availability:focus-visible {
  outline: 2px solid var(--kobo-accent);
  outline-offset: 2px;
}
.availability-link { color: var(--kobo-text-2); }
</style>
