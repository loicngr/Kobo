<template>
  <q-dialog v-model="isVisible" persistent no-backdrop-dismiss>
    <q-card style="min-width: 400px;">
      <q-card-section v-if="store.status.state === 'backing-up'">
        <div class="text-h6">{{ t('migration.backing_up') }}</div>
        <q-spinner class="q-mt-md" />
      </q-card-section>

      <q-card-section v-else-if="store.status.state === 'running'">
        <div class="text-h6">
          {{ t('migration.running', { processed: store.status.processed, total: store.status.total }) }}
        </div>
        <q-linear-progress
          :value="store.status.total > 0 ? store.status.processed / store.status.total : 0"
          class="q-mt-md"
        />
      </q-card-section>

      <q-card-section v-else-if="store.status.state === 'error'">
        <div class="text-h6 text-negative">{{ t('migration.error') }}</div>
        <div class="q-mt-sm">{{ store.status.errorMessage }}</div>
        <div v-if="store.status.backupPath" class="q-mt-md text-caption">
          {{ t('migration.backup_location', { path: store.status.backupPath }) }}
        </div>
        <div class="q-mt-md text-caption">{{ t('migration.retry') }}</div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { useMigrationStore } from 'src/stores/migration'
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useMigrationStore()
const isVisible = computed(() => ['backing-up', 'running', 'error'].includes(store.status.state))

onMounted(() => {
  void store.fetchInitial()
})
</script>
