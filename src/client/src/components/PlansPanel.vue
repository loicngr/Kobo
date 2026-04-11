<script setup lang="ts">
import DOMPurify from 'dompurify'
import { useQuasar } from 'quasar'
import type { Workspace } from 'src/stores/workspace'
import { useTimeAgo } from 'src/utils/formatters'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'

const props = defineProps<{
  workspace: Workspace | null
}>()

const { t } = useI18n()
const $q = useQuasar()
const { timeAgo } = useTimeAgo()

interface PlanFile {
  path: string
  name: string
  modifiedAt: string
}

const plans = ref<PlanFile[]>([])
const loading = ref(false)
const selectedPlan = ref<{ path: string; content: string; name: string } | null>(null)
const loadingContent = ref(false)

async function fetchPlans() {
  if (!props.workspace) {
    plans.value = []
    return
  }
  loading.value = true
  try {
    const res = await fetch(`/api/workspaces/${props.workspace.id}/plans`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { plans: PlanFile[] }
    plans.value = body.plans
  } catch (err) {
    console.error('[PlansPanel] fetchPlans failed:', err)
    plans.value = []
  } finally {
    loading.value = false
  }
}

async function openPlan(plan: PlanFile) {
  loadingContent.value = true
  try {
    const res = await fetch(
      `/api/workspaces/${props.workspace!.id}/plan-file?path=${encodeURIComponent(plan.path)}`,
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { content: string; path: string }
    selectedPlan.value = { path: body.path, content: body.content, name: plan.name }
  } catch (err) {
    console.error('[PlansPanel] openPlan failed:', err)
    $q.notify({ type: 'negative', message: t('plans.loadFailed'), position: 'top' })
  } finally {
    loadingContent.value = false
  }
}

function closePlan() {
  selectedPlan.value = null
}

const renderedMarkdown = computed(() => {
  if (!selectedPlan.value) return ''
  const html = marked.parse(selectedPlan.value.content, { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(html)
})

// Re-fetch plans when workspace changes
watch(
  () => props.workspace?.id,
  () => {
    selectedPlan.value = null
    fetchPlans()
  },
  { immediate: true },
)
</script>

<template>
  <div class="plans-panel q-pa-md">
    <!-- Header -->
    <div class="row items-center justify-between q-mb-sm">
      <div class="text-caption text-uppercase text-weight-bold text-grey-6" style="letter-spacing: 0.05em;">
        {{ $t('plans.title') }}
      </div>
      <q-btn
        v-if="!selectedPlan"
        flat
        round
        dense
        size="xs"
        icon="refresh"
        color="grey-6"
        :loading="loading"
        @click="fetchPlans"
      >
        <q-tooltip>{{ $t('plans.refresh') }}</q-tooltip>
      </q-btn>
      <q-btn
        v-else
        flat
        dense
        no-caps
        size="sm"
        icon="arrow_back"
        :label="$t('plans.back')"
        color="grey-5"
        @click="closePlan"
      />
    </div>

    <!-- List view -->
    <template v-if="!selectedPlan">
      <div v-if="!workspace" class="text-caption text-grey-8">
        {{ $t('common.selectWorkspace') }}
      </div>

      <div v-else-if="loading" class="text-center q-py-lg">
        <q-spinner size="24px" color="grey-6" />
      </div>

      <div v-else-if="plans.length === 0" class="text-caption text-grey-8 text-center q-py-lg">
        {{ $t('plans.empty') }}
      </div>

      <q-list v-else dense dark>
        <q-item
          v-for="plan in plans"
          :key="plan.path"
          clickable
          v-ripple
          dense
          @click="openPlan(plan)"
        >
          <q-item-section avatar style="min-width: 28px;">
            <q-icon name="description" size="14px" color="grey-6" />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-grey-3 ellipsis" style="font-family: 'Roboto Mono', monospace; font-size: 11px;">
              {{ plan.name }}
            </q-item-label>
            <q-item-label caption style="font-size: 10px;">
              {{ timeAgo(plan.modifiedAt) }}
            </q-item-label>
          </q-item-section>
        </q-item>
      </q-list>
    </template>

    <!-- Detail view (markdown rendered) -->
    <template v-else>
      <div v-if="loadingContent" class="text-center q-py-lg">
        <q-spinner size="24px" color="grey-6" />
      </div>
      <div v-else class="plan-content" v-html="renderedMarkdown" />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.plan-content {
  font-size: 12px;
  color: #d0d0d0;
  line-height: 1.6;
  overflow-wrap: break-word;

  :deep(h1) { font-size: 16px; color: #e0e0e0; margin: 16px 0 8px; }
  :deep(h2) { font-size: 14px; color: #e0e0e0; margin: 14px 0 6px; }
  :deep(h3) { font-size: 13px; color: #e0e0e0; margin: 12px 0 4px; }
  :deep(code) {
    background: #1a1a2e;
    padding: 1px 4px;
    border-radius: 3px;
    font-family: 'Roboto Mono', monospace;
    font-size: 11px;
  }
  :deep(pre) {
    background: #1a1a2e;
    padding: 8px 12px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 11px;
  }
  :deep(pre code) {
    background: none;
    padding: 0;
  }
  :deep(ul), :deep(ol) {
    padding-left: 20px;
  }
  :deep(li) {
    margin-bottom: 2px;
  }
  :deep(input[type="checkbox"]) {
    margin-right: 6px;
    pointer-events: none;
  }
  :deep(table) {
    border-collapse: collapse;
    width: 100%;
    font-size: 11px;
    margin: 8px 0;
  }
  :deep(th), :deep(td) {
    border: 1px solid #2a2a4a;
    padding: 4px 8px;
    text-align: left;
  }
  :deep(th) {
    background: #1a1a2e;
    color: #e0e0e0;
  }
  :deep(blockquote) {
    border-left: 3px solid #4a4a6a;
    margin: 8px 0;
    padding: 4px 12px;
    color: #a0a0b0;
  }
  :deep(a) {
    color: #818cf8;
  }
  :deep(hr) {
    border: none;
    border-top: 1px solid #2a2a4a;
    margin: 12px 0;
  }
}
</style>
