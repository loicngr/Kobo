<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MemoryProposal } from '../../../../shared/memory'

withDefaults(defineProps<{ proposals: MemoryProposal[]; busyProposalId?: string | null }>(), { busyProposalId: null })
const emit = defineEmits<{ decision: [proposalId: string, decision: 'approve' | 'reject'] }>()
const { t } = useI18n()
</script>

<template>
  <div class="memory-proposal-list">
    <p v-if="proposals.length === 0" class="memory-empty">{{ t('memory.proposal.empty') }}</p>
    <article v-for="proposal in proposals" :key="proposal.id" class="memory-proposal">
      <div>
        <h3>{{ proposal.title }}</h3>
        <p class="memory-proposal__key">{{ proposal.key }}</p>
        <p>{{ proposal.body }}</p>
      </div>
      <div class="memory-proposal__actions">
        <button type="button" :aria-label="t('memory.proposal.approveAria', { title: proposal.title })" :disabled="busyProposalId === proposal.id" @click="emit('decision', proposal.id, 'approve')">
          {{ t('memory.proposal.approve') }}
        </button>
        <button type="button" :aria-label="t('memory.proposal.rejectAria', { title: proposal.title })" :disabled="busyProposalId === proposal.id" @click="emit('decision', proposal.id, 'reject')">
          {{ t('memory.proposal.reject') }}
        </button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.memory-proposal-list { display: grid; gap: var(--kobo-space-md); }
.memory-proposal { display: flex; justify-content: space-between; gap: var(--kobo-space-lg); padding: var(--kobo-space-md); border: 1px solid var(--kobo-border-subtle); border-radius: var(--kobo-radius-md); background: var(--kobo-surface); }
.memory-proposal h3, .memory-proposal p { margin: 0; }
.memory-proposal h3 { font-size: 1rem; line-height: 1.5; font-weight: 600; }
.memory-proposal__key { color: var(--kobo-text-2); }
.memory-proposal__actions { display: flex; align-items: start; gap: var(--kobo-space-sm); }
.memory-empty { color: var(--kobo-text-2); }
@media (max-width: 600px) { .memory-proposal { flex-direction: column; } }
</style>
