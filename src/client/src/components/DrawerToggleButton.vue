<template>
  <q-btn
    v-if="shouldShow"
    flat
    dense
    round
    size="sm"
    :icon="layout.leftDrawerOpen ? 'menu_open' : 'menu'"
    @click="layout.toggleLeft()"
  >
    <q-tooltip>{{ $t('layout.toggleWorkspaces') }}</q-tooltip>
  </q-btn>
</template>

<script setup lang="ts">
import { useIsMobile } from 'src/composables/use-is-mobile'
import { useLayoutStore } from 'src/stores/layout'
import { computed } from 'vue'

/**
 * Re-opens the global left drawer when it's collapsed to an overlay
 * (< 1024px). Shared by SearchPage, CreatePage, HealthPage, ChangelogPage
 * (plain `isDrawerCollapsed` gate) and SettingsPage (`excludeMobile`, to
 * avoid double hamburgers with its own < 600px mobile nav drawer toggle).
 */
const props = defineProps<{ excludeMobile?: boolean }>()

const layout = useLayoutStore()
const { isMobile, isDrawerCollapsed } = useIsMobile()

const shouldShow = computed(() =>
  props.excludeMobile ? isDrawerCollapsed.value && !isMobile.value : isDrawerCollapsed.value,
)
</script>
