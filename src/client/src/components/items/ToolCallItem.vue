<script setup lang="ts">
import type { ConversationItem } from 'src/services/agent-event-view'
import { computeInlineDiff, type DiffLine, getFileChangeInfo } from 'src/services/inline-diff'
import { useWorkspaceStore } from 'src/stores/workspace'
import { compactPath } from 'src/utils/compact-path'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ item: Extract<ConversationItem, { type: 'tool' }> }>()

const expanded = ref(false)
const workspaceStore = useWorkspaceStore()

const fileChange = computed(() => getFileChangeInfo(props.item.name, props.item.input))
const displayFilePath = computed(() =>
  fileChange.value ? compactPath(fileChange.value.filePath, workspaceStore.selectedWorkspace) : '',
)

// Material Icons per tool — restores the visual identity users were used
// to pre-refactor. Falls back to `build` for unknown tools.
const TOOL_ICONS: Record<string, string> = {
  Bash: 'terminal',
  Read: 'description',
  Edit: 'edit',
  Write: 'edit_note',
  MultiEdit: 'edit',
  Glob: 'folder_open',
  Grep: 'manage_search',
  LS: 'list',
  Skill: 'auto_awesome',
  Task: 'hub',
  Agent: 'hub',
  TodoWrite: 'checklist',
  TodoRead: 'checklist',
  ToolSearch: 'search',
  WebFetch: 'public',
  WebSearch: 'travel_explore',
  NotebookRead: 'book',
  NotebookEdit: 'edit_note',
  SendMessage: 'send',
  ExitPlanMode: 'check_circle_outline',
  KillShell: 'stop_circle',
  BashOutput: 'terminal',
}
const toolIcon = computed(() => TOOL_ICONS[props.item.name] ?? 'build')

const fallbackLabel = computed(() => {
  if (fileChange.value) return ''
  const input = props.item.input
  const raw = extractRawLabel(input)
  return raw ? compactPath(raw, workspaceStore.selectedWorkspace) : ''
})

function extractRawLabel(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : ''
  const rec = input as Record<string, unknown>
  const keys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'skill', 'description', 'subject', 'prompt']
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

const diffLines = computed<DiffLine[] | null>(() => {
  const fc = fileChange.value
  if (!fc) return null
  if (fc.toolName === 'Edit' && fc.oldString !== undefined && fc.newString !== undefined) {
    return computeInlineDiff(fc.oldString, fc.newString)
  }
  if (fc.toolName === 'Write' && fc.content !== undefined) {
    return fc.content.split('\n').map((line) => ({ type: 'add' as const, content: line }))
  }
  if (fc.toolName === 'Bash:rm') {
    return [{ type: 'del' as const, content: 'File deleted' }]
  }
  return null
})

const outputSummary = computed(() => {
  const result = props.item.result
  if (!result) return ''
  if (typeof result.output === 'string') return result.output
  try {
    return JSON.stringify(result.output)
  } catch {
    return String(result.output)
  }
})

// Tools whose output is pure noise (file content the user already knows,
// directory listings, etc.). The header stays visible but the expandable
// body and chevron are hidden entirely — the UI should show "Read foo.ts"
// and nothing else. Errors still auto-expand via the watcher below.
const NOISY_OUTPUT_TOOLS = new Set(['Read'])

const canToggleOutput = computed(
  () =>
    Boolean(props.item.result && outputSummary.value) &&
    (!NOISY_OUTPUT_TOOLS.has(props.item.name) || props.item.result?.isError === true),
)

function toggleExpand() {
  expanded.value = !expanded.value
}

// Auto-expand whenever the tool result arrives with `isError === true` so
// failures are visible without the user having to click. A subsequent
// manual collapse still works (watcher only sets true, never false).
watch(
  () => props.item.result?.isError === true,
  (isErr) => {
    if (isErr) expanded.value = true
  },
  { immediate: true },
)
</script>

<template>
  <!-- File-mutating tool: compact header row, expandable inline diff -->
  <div v-if="fileChange" class="tool-row" :class="{ 'tool-row-expanded': expanded }">
    <div class="tool-header" @click="toggleExpand">
      <q-icon :name="toolIcon" size="14px" class="tool-icon" />
      <span class="tool-name">{{ fileChange.toolName === 'Bash:rm' ? 'Bash' : fileChange.toolName }}</span>
      <span class="tool-path" :title="fileChange.filePath">{{ displayFilePath }}</span>
      <span v-if="fileChange.additions > 0" class="tool-stat-add">+{{ fileChange.additions }}</span>
      <span v-if="fileChange.deletions > 0" class="tool-stat-del">-{{ fileChange.deletions }}</span>
      <q-icon
        v-if="item.result?.isError"
        name="error_outline"
        color="negative"
        size="xs"
        class="q-ml-xs"
      />
      <q-icon v-else-if="item.result" name="check" color="positive" size="xs" class="q-ml-xs" />
      <q-icon :name="expanded ? 'expand_less' : 'expand_more'" size="xs" class="q-ml-auto text-grey-6" />
    </div>
    <div v-if="expanded && diffLines" class="tool-diff" @click.stop>
      <div
        v-for="(line, li) in diffLines"
        :key="li"
        class="diff-line"
        :class="{
          'diff-del': line.type === 'del',
          'diff-add': line.type === 'add',
          'diff-context': line.type === 'context',
        }"
      ><span class="diff-sign">{{ line.type === 'del' ? '-' : line.type === 'add' ? '+' : ' ' }}</span>{{ line.content }}</div>
    </div>
  </div>

  <!-- Generic tool: one compact line with icon + name + primary arg + status -->
  <div
    v-else
    class="tool-row tool-row-generic"
    :class="{ 'tool-row-expanded': expanded, 'tool-row--toggleable': canToggleOutput }"
  >
    <div class="tool-header" @click="canToggleOutput && toggleExpand()">
      <q-icon :name="toolIcon" size="14px" class="tool-icon" />
      <span class="tool-name">{{ item.name }}</span>
      <span v-if="fallbackLabel" class="tool-arg" :title="extractRawLabel(item.input) || fallbackLabel">{{ fallbackLabel }}</span>
      <q-icon
        v-if="item.result?.isError"
        name="error_outline"
        color="negative"
        size="xs"
        class="q-ml-auto"
      />
      <q-icon v-else-if="item.result" name="check" color="positive" size="xs" class="q-ml-auto" />
      <q-icon
        v-if="canToggleOutput"
        :name="expanded ? 'expand_less' : 'expand_more'"
        size="xs"
        class="q-ml-xs text-grey-6"
      />
    </div>
    <div
      v-if="expanded && canToggleOutput"
      class="tool-output"
      @click.stop
    >
      {{ outputSummary }}
    </div>
  </div>
</template>

<style scoped>
.tool-row {
  font-size: 12px;
  border-radius: 4px;
  margin: 0;
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  color: #bbb;
  cursor: default;
  min-width: 0;
}
.tool-row:has(.tool-diff) .tool-header,
.tool-row:not(.tool-row-generic) .tool-header,
.tool-row--toggleable .tool-header {
  cursor: pointer;
}
.tool-row:not(.tool-row-generic) .tool-header:hover,
.tool-row--toggleable .tool-header:hover {
  background: rgba(255, 255, 255, 0.03);
}
.tool-icon {
  color: #9fbce0;
  flex-shrink: 0;
}
.tool-name {
  font-weight: 600;
  color: #d0d0d0;
  flex-shrink: 0;
}
.tool-arg,
.tool-path {
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 100%;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.tool-path {
  flex: 1;
}
.tool-arg {
  flex: 1;
}
.tool-stat-add {
  color: #66bb6a;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
}
.tool-stat-del {
  color: #ef5350;
  font-weight: 600;
  font-size: 11px;
  flex-shrink: 0;
}
.tool-diff {
  margin-top: 4px;
  padding: 8px 0;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  max-height: 400px;
  overflow: auto;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}
.diff-line {
  padding: 0 12px;
  white-space: pre;
  color: #bbb;
}
.diff-sign {
  display: inline-block;
  width: 14px;
  color: #555;
  user-select: none;
}
.diff-add {
  background: rgba(102, 187, 106, 0.1);
  color: #c8e6c9;
}
.diff-add .diff-sign {
  color: #66bb6a;
}
.diff-del {
  background: rgba(239, 83, 80, 0.1);
  color: #ffcdd2;
}
.diff-del .diff-sign {
  color: #ef5350;
}
.tool-output {
  margin-top: 4px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 4px;
  color: #aaa;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  max-height: 8em;
  overflow: auto;
}
</style>
