<template>
  <q-btn flat round dense icon="help_outline" size="sm" color="kobo-2" :aria-label="$t('help.replayThis')" @click="replay">
    <q-tooltip>{{ $t('help.replayThis') }}</q-tooltip>
  </q-btn>
</template>

<script setup lang="ts">
import { useTours } from 'src/composables/use-tours'
import type { TourId } from 'src/tours/types'

// Single-root component: `class` and other attrs fall through to the q-btn.
const props = defineProps<{ tourId: TourId }>()

const { runTour } = useTours()

function replay(): void {
  void runTour(props.tourId)
}
</script>
