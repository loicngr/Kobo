<template>
  <div class="review-comment-block">
    <q-resize-observer @resize="(size) => emit('resize', size)" />
    <div
      v-for="(comment, idx) in comments"
      :key="comment.id"
      class="comment-thread-item"
      :class="{ 'with-separator': idx > 0 }"
    >
      <template v-if="editingId === comment.id">
        <q-input
          v-model="editingContent"
          type="textarea"
          autogrow
          dense
          dark
          outlined
          autofocus
          class="comment-textarea"
          :placeholder="$t('diff.commentPlaceholder')"
        :aria-label="$t('diff.commentPlaceholder')"
        />
        <div class="comment-actions q-mt-xs">
          <q-btn flat no-caps dense size="sm" :label="$t('common.cancel')" @click="cancelEdit" />
          <q-btn unelevated no-caps dense size="sm" color="primary" :label="$t('common.save')" @click="saveEdit(comment.id)" />
        </div>
      </template>
      <template v-else>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="comment-content" v-html="renderMarkdown(comment.content)" />
        <div class="comment-footer">
          <span class="comment-time text-caption text-kobo-3">{{ relativeTime(comment.createdAt) }}</span>
          <q-btn flat dense round size="xs" icon="edit" :aria-label="$t('diff.editComment')" color="kobo-2" @click="startEdit(comment)">
            <q-tooltip>{{ $t('diff.editComment') }}</q-tooltip>
          </q-btn>
          <q-btn flat dense round size="xs" icon="delete" :aria-label="$t('diff.deleteComment')" color="kobo-2" @click="confirmDelete(comment.id)">
            <q-tooltip>{{ $t('diff.deleteComment') }}</q-tooltip>
          </q-btn>
        </div>
      </template>
    </div>
    <template v-if="addingNew">
      <q-input
        v-model="newContent"
        type="textarea"
        autogrow
        dense
        dark
        outlined
        autofocus
        class="comment-textarea q-mt-sm"
        :placeholder="$t('diff.commentPlaceholder')"
        :aria-label="$t('diff.commentPlaceholder')"
      />
      <div class="comment-actions q-mt-xs">
        <q-btn flat no-caps dense size="sm" :label="$t('common.cancel')" @click="cancelAdd" />
        <q-btn
          unelevated
          no-caps
          dense
          size="sm"
          color="primary"
          :disable="!newContent.trim()"
          :label="$t('diff.addComment')"
          @click="confirmAdd"
        />
      </div>
    </template>
    <q-btn
      v-else-if="comments.length > 0"
      flat
      no-caps
      dense
      size="sm"
      icon="reply"
      :label="$t('diff.replyComment')"
      class="reply-btn q-mt-xs"
      @click="addingNew = true"
    />
  </div>
</template>

<script setup lang="ts">
import { useQuasar } from 'quasar'
import type { ReviewComment } from 'src/composables/use-review-draft'
import { renderChatMarkdown } from 'src/utils/render-chat-markdown'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  comments: ReviewComment[]
  startInAddMode?: boolean
}>()

const emit = defineEmits<{
  resize: [size: { width: number; height: number }]
  add: [content: string]
  update: [id: string, content: string]
  delete: [id: string]
  /** Fired when the user cancels the "add" textarea AND no existing comments
      remain — the parent should dispose the empty view zone. */
  dismissEmpty: []
}>()

const { t } = useI18n()
const $q = useQuasar()

const editingId = ref<string | null>(null)
const editingContent = ref('')
const addingNew = ref(props.startInAddMode === true)
const newContent = ref('')

function renderMarkdown(raw: string): string {
  return renderChatMarkdown(raw)
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return t('common.justNow')
  if (diffMin < 60) return t('common.minutesAgo', { count: diffMin })
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return t('common.hoursAgo', { count: diffH })
  return t('common.daysAgo', { count: Math.floor(diffH / 24) })
}

function startEdit(c: ReviewComment) {
  editingId.value = c.id
  editingContent.value = c.content
}

function cancelEdit() {
  editingId.value = null
  editingContent.value = ''
}

function saveEdit(id: string) {
  const trimmed = editingContent.value.trim()
  if (!trimmed) return
  emit('update', id, trimmed)
  editingId.value = null
  editingContent.value = ''
}

function confirmDelete(id: string) {
  $q.dialog({
    title: t('diff.deleteComment'),
    message: t('diff.deleteCommentConfirm'),
    cancel: true,
    persistent: true,
    ok: { label: t('diff.deleteComment'), color: 'negative', flat: false, unelevated: true },
  }).onOk(() => {
    emit('delete', id)
  })
}

function cancelAdd() {
  addingNew.value = false
  newContent.value = ''
  // Transient zone (no real comments yet): tell the parent to dispose it,
  // otherwise an empty bubble lingers over the diff.
  if (props.comments.length === 0) {
    emit('dismissEmpty')
  }
}

function confirmAdd() {
  const trimmed = newContent.value.trim()
  if (!trimmed) return
  emit('add', trimmed)
  addingNew.value = false
  newContent.value = ''
}
</script>

<style scoped>
.review-comment-block {
  position: relative;
  background: var(--kobo-surface);
  border: 1px solid var(--kobo-border);
  border-radius: var(--kobo-radius-sm);
  padding: var(--kobo-space-md);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.comment-thread-item.with-separator {
  border-top: 1px solid rgba(var(--kobo-accent-rgb), 0.2);
  margin-top: 6px;
  padding-top: 6px;
}
.comment-content :deep(p) {
  margin: 0 0 0.3em;
}
.comment-content :deep(p:last-child) {
  margin-bottom: 0;
}
.comment-content :deep(code) {
  background: rgba(0, 0, 0, 0.3);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
.comment-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.comment-time {
  margin-right: auto;
}
.comment-actions {
  display: flex;
  gap: var(--kobo-space-sm);
  justify-content: flex-end;
  flex-wrap: wrap;
}
.comment-textarea {
  font-size: 14px;
}
.reply-btn {
  font-size: 11px;
}
@media (max-width: 1023px) {
  .review-comment-block :deep(.q-btn) { min-height: 44px; min-width: 44px; }
  .comment-textarea { font-size: 16px; }
}
</style>
