<template>
  <div class="review-draft-panel q-pa-sm">
    <div class="text-caption text-uppercase text-weight-bold text-grey-6 q-mb-sm" style="letter-spacing: 0.05em;">
      {{ $t('diff.reviewDraft') }}
    </div>

    <q-scroll-area class="comments-scroll" style="height: calc(100% - 220px);">
      <div v-if="grouped.length === 0" class="text-caption text-grey-7 q-pa-sm">
        {{ $t('diff.reviewEmpty') }}
      </div>
      <div v-for="group in grouped" :key="group.filePath" class="file-group q-mb-sm">
        <div class="file-group-header text-grey-3 cursor-pointer ellipsis" @click="emit('jumpToFile', group.filePath)">
          <q-icon name="description" size="14px" color="indigo-4" class="q-mr-xs" />
          <span style="font-family: 'Roboto Mono', monospace; font-size: 11px;">{{ group.filePath }}</span>
          <q-badge :label="String(group.comments.length)" color="indigo-8" text-color="white" class="q-ml-xs" />
        </div>
        <div
          v-for="c in group.comments"
          :key="c.id"
          class="draft-line cursor-pointer"
          @click="emit('jumpToComment', c.filePath, c.line)"
        >
          <span class="text-grey-6 q-mr-xs" style="font-family: monospace;">L{{ c.line }}</span>
          <span class="text-grey-3 ellipsis">{{ snippet(c.content) }}</span>
        </div>
      </div>
    </q-scroll-area>

    <div class="global-message-box q-mt-sm">
      <q-input
        :model-value="globalMessage"
        type="textarea"
        autogrow
        rows="3"
        dense
        dark
        outlined
        :placeholder="$t('diff.reviewGlobalPlaceholder')"
        class="global-textarea"
        @update:model-value="(v) => emit('updateGlobal', String(v))"
      />
      <q-btn
        unelevated
        no-caps
        color="primary"
        class="full-width q-mt-sm"
        :disable="totalCount === 0 && !globalMessage.trim()"
        :loading="submitting"
        @click="emit('submit')"
      >
        {{ $t('diff.submitReview', { n: totalCount }) }}
      </q-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ReviewComment } from 'src/composables/use-review-draft'
import { computed } from 'vue'

const props = defineProps<{
  comments: ReviewComment[]
  globalMessage: string
  submitting: boolean
}>()

const emit = defineEmits<{
  updateGlobal: [value: string]
  jumpToFile: [filePath: string]
  jumpToComment: [filePath: string, line: number]
  submit: []
}>()

const totalCount = computed(() => props.comments.length)

const grouped = computed(() => {
  const map = new Map<string, ReviewComment[]>()
  for (const c of props.comments) {
    const list = map.get(c.filePath) ?? []
    list.push(c)
    map.set(c.filePath, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.line - b.line || a.createdAt.localeCompare(b.createdAt))
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, comments]) => ({ filePath, comments }))
})

function snippet(content: string): string {
  const oneLine = content.replace(/\n+/g, ' ').trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine
}
</script>

<style scoped>
.review-draft-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  border-right: 1px solid #2a2a4a;
}
.file-group-header {
  font-weight: 500;
  padding: 4px 0;
  display: flex;
  align-items: center;
}
.draft-line {
  padding: 2px 8px 2px 20px;
  font-size: 11px;
  display: flex;
  gap: 4px;
  align-items: center;
}
.draft-line:hover {
  background: rgba(99, 102, 241, 0.1);
}
.global-message-box {
  flex-shrink: 0;
}
.global-textarea {
  font-size: 12px;
}
</style>
