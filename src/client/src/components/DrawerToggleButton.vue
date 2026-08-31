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

// TOUTE la navigation (créer, réglages, recherche, santé, changelog) vit dans
// le tiroir gauche. Le gate d'origine ne montrait ce bouton que sous 1024 px :
// sur un écran large, fermer le tiroir puis changer de page enfermait
// l'utilisateur hors de toute navigation, sans autre issue que le bouton
// retour du navigateur. On l'affiche donc dès que le tiroir n'est pas ouvert,
// quelle que soit la largeur.
const shouldShow = computed(() => {
  // `excludeMobile` sert à SettingsPage, qui a son propre menu hamburger sous
  // 600 px : deux hamburgers côte à côte seraient illisibles.
  if (props.excludeMobile && isMobile.value) return false
  return isDrawerCollapsed.value || !layout.leftDrawerOpen
})
</script>
