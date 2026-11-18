<template>
  <div v-if="path" class="row items-center no-wrap q-mt-xs" data-test="kept-ai-notice">
    <i18n-t keypath="workspacePage.keptAiFolder" tag="span" class="text-caption text-kobo-2 col kept-ai-text">
      <template #path>
        <code class="kept-ai-path text-kobo-1" data-test="kept-ai-path">{{ path }}</code>
      </template>
    </i18n-t>
    <q-btn
      flat
      dense
      round
      size="sm"
      color="kobo-2"
      icon="content_copy"
      :aria-label="$t('workspacePage.copyKeptAiPath')"
      data-test="kept-ai-copy"
      @click="copyToClipboard($q, t, path)"
    >
      <q-tooltip>{{ $t('workspacePage.copyKeptAiPath') }}</q-tooltip>
    </q-btn>
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import { copyToClipboard } from 'src/utils/clipboard'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { keptAiPathOf } from '../../../shared/kept-ai'

const props = defineProps<{ workspaceId: string; restoreData: string | null | undefined }>()

const $q = useQuasar()
const { t } = useI18n()
const path = computed(() => keptAiPathOf(props.workspaceId, props.restoreData))
</script>

<style scoped>
/* The whole path must stay readable on narrow screens: break anywhere, keep it selectable. */
.kept-ai-text,
.kept-ai-path {
  overflow-wrap: anywhere;
  user-select: text;
}
</style>
