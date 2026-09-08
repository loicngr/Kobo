<template>
  <q-btn
    flat
    round
    dense
    icon="help_outline"
    size="sm"
    color="kobo-2"
    data-tour="help"
    aria-haspopup="menu"
    :aria-expanded="menuOpen"
    :aria-label="$t('help.title')"
  >
    <q-tooltip>{{ $t('help.title') }}</q-tooltip>
    <q-menu v-model="menuOpen" anchor="bottom right" self="top right">
      <q-list dense role="menu" style="min-width: 260px">
        <q-item-label header>{{ $t('help.tours') }}</q-item-label>
        <q-item
          v-for="tour in tours"
          :key="tour.id"
          v-close-popup
          clickable
          role="menuitem"
          @click="run(tour.id)"
        >
          <q-item-section avatar>
            <!-- status() reads the shared reactive seen-map, so the dots update as tours are watched. -->
            <q-icon :name="statusIcon(status(tour.id))" size="xs" :class="statusClass(status(tour.id))" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ $t(`${tour.i18nKey}.title`) }}</q-item-label>
            <!-- The status is spelled out here so screen readers get it, not only the coloured dot. -->
            <q-item-label caption>
              {{ $t('help.steps', { n: countRunnableSteps(tour) }, countRunnableSteps(tour)) }} · {{ $t(`help.status.${status(tour.id)}`) }}
            </q-item-label>
          </q-item-section>
        </q-item>
        <q-separator />
        <q-item v-close-popup clickable role="menuitem" @click="resetAllTours">
          <q-item-section avatar><q-icon name="replay" size="xs" /></q-item-section>
          <q-item-section>
            <q-item-label>{{ $t('help.resetAll') }}</q-item-label>
            <q-item-label caption>{{ $t('help.resetAllHint') }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </q-menu>
  </q-btn>
</template>

<script setup lang="ts">
import { countRunnableSteps, useTours } from 'src/composables/use-tours'
import type { TourId, TourStatus } from 'src/tours/types'
import { ref } from 'vue'

const { tours, status, runTour, resetAll } = useTours()
const menuOpen = ref(false)

function run(id: TourId): void {
  void runTour(id)
}

function resetAllTours(): void {
  void resetAll()
}

function statusIcon(s: TourStatus): string {
  if (s === 'seen') return 'check_circle'
  return s === 'partial' ? 'adjust' : 'radio_button_unchecked'
}

function statusClass(s: TourStatus): string {
  if (s === 'seen') return 'text-kobo-success'
  return s === 'partial' ? 'text-kobo-warning' : 'text-kobo-3'
}
</script>
