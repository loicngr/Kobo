<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card dark style="min-width: 560px; max-width: 720px; width: 100%;">
      <q-card-section>
        <div class="text-subtitle1 text-kobo-1">{{ $t('prPicker.title') }}</div>
      </q-card-section>

      <q-separator dark />

      <q-card-section class="column q-gutter-y-md">
        <q-btn-toggle
          v-model="filter"
          spread
          no-caps
          unelevated
          toggle-color="primary"
          color="kobo-surface-2"
          text-color="kobo-2"
          :options="filterOptions"
        />

        <q-input
          v-model="search"
          dense
          dark
          outlined
          debounce="300"
          clearable
          :placeholder="$t('prPicker.searchPlaceholder')"
        >
          <template #prepend><q-icon name="search" size="18px" /></template>
        </q-input>
      </q-card-section>

      <q-separator dark />

      <q-card-section class="pr-picker__list-section" ref="listSectionEl">
        <div v-if="error" class="text-caption text-negative q-pa-md">{{ error }}</div>

        <q-list v-else-if="items.length > 0" dark class="pr-picker__list">
          <q-item
            v-for="item in items"
            :key="item.number"
            clickable
            :disable="item.isFork"
            class="pr-picker__item"
            :ref="(el) => registerRow(el, item.number)"
            @click="selectItem(item)"
          >
            <q-item-section>
              <q-item-label class="row items-center q-gutter-x-xs no-wrap">
                <span class="text-kobo-3" style="font-family: var(--kobo-font-mono); font-size: var(--kobo-space-md);">#{{ item.number }}</span>
                <span class="text-kobo-1 ellipsis">{{ item.title }}</span>
                <q-icon v-if="item.ci === 'SUCCESS'" name="check_circle" color="positive" size="14px" />
                <q-icon v-else-if="item.ci === 'FAILURE'" name="cancel" color="negative" size="14px" />
                <q-badge v-if="item.isDraft" color="kobo-hover" text-color="kobo-2" :label="$t('prPicker.badge.draft')" />
                <q-badge
                  v-if="collisionBadge(item.number)"
                  color="kobo-surface-2"
                  text-color="kobo-2"
                  :label="$t(collisionBadge(item.number)!)"
                />
              </q-item-label>
              <q-item-label caption class="text-kobo-3">
                @{{ item.author }} &middot;
                <span style="font-family: var(--kobo-font-mono);">{{ item.headBranch }}</span>
                <q-icon name="arrow_forward" size="11px" class="q-mx-xs" />
                <span style="font-family: var(--kobo-font-mono);">{{ item.baseBranch }}</span>
              </q-item-label>
            </q-item-section>

            <q-tooltip v-if="item.isFork">{{ $t('prPicker.forkNotSupported') }}</q-tooltip>
          </q-item>
        </q-list>

        <div v-else-if="!loading" class="text-caption text-kobo-3 q-pa-md">{{ $t('prPicker.empty') }}</div>

        <div v-if="loading" class="row justify-center q-pa-md">
          <q-spinner color="primary" size="var(--kobo-space-2xl)" />
        </div>

        <div v-if="!loading && nextCursor !== null" class="row justify-center q-pa-md">
          <q-btn flat no-caps :label="$t('prPicker.loadMore')" color="kobo-2" @click="loadMore" />
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps :label="$t('common.cancel')" color="kobo-2" @click="emit('update:modelValue', false)" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PrCheckoutReport } from '../utils/pr-checkout-steps'

export interface PullRequestSummary {
  number: number
  title: string
  url: string
  author: string
  headBranch: string
  baseBranch: string
  isFork: boolean
  isDraft: boolean
  updatedAt: string
  ci: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'CANCELLED' | 'NEUTRAL' | null
  reviewDecision: string | null
}

const props = defineProps<{
  modelValue: boolean
  projectPath: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  select: [pr: PullRequestSummary]
}>()

const { t } = useI18n()

type FilterValue = 'all' | 'mine' | 'review-requested'

const filterOptions: Array<{ label: string; value: FilterValue }> = [
  { label: t('prPicker.filterAll'), value: 'all' },
  { label: t('prPicker.filterMine'), value: 'mine' },
  { label: t('prPicker.filterReviewRequested'), value: 'review-requested' },
]

const listSectionEl = ref<{ $el?: HTMLElement } | null>(null)
const items = ref<PullRequestSummary[]>([])
const nextCursor = ref<string | null>(null)
const filter = ref<FilterValue>('all')
const search = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

// Diagnosis cache for the collision badges (Step 2). Keyed by PR number.
// `undefined` = not yet requested, `null` = requested and either still in
// flight or permanently failed (no badge either way) — set BEFORE the fetch
// starts so a slow/failed request never gets re-triggered on every scroll
// event or page reset. A transient network blip (e.g. Chrome's
// ERR_NETWORK_CHANGED firing for every in-flight request at once) must not
// turn into an unbounded retry loop.
const diagnoses = reactive<Record<number, PrCheckoutReport | null>>({})

function badgeKeyFor(report: PrCheckoutReport): string {
  if (report.workspace.state !== 'none') return 'prPicker.badge.workspaceExists'
  if (report.worktree.state === 'orphan') return 'prPicker.badge.worktreePresent'
  if (report.branch.state !== 'absent') return 'prPicker.badge.localBranch'
  return 'prPicker.badge.new'
}

function collisionBadge(prNumber: number): string | null {
  const report = diagnoses[prNumber]
  if (!report) return null
  return badgeKeyFor(report)
}

// Per-PR abort controllers for in-flight diagnose calls, so closing the
// dialog mid-scroll cancels every pending preview request instead of letting
// them complete uselessly against a dialog nobody is looking at.
const diagnoseControllers = new Map<number, AbortController>()

// Each `/diagnose` call runs real git operations server-side and can take
// several seconds. Letting every "visible" row fire its own fetch at once
// saturates the browser's per-origin connection limit, which reads as
// slowness and, under any network hiccup, as a wave of simultaneous
// failures. A small concurrency cap keeps this predictable regardless of how
// many rows the observer reports as visible at once.
const MAX_CONCURRENT_DIAGNOSES = 3
let activeDiagnoses = 0
const diagnoseQueue: number[] = []

function runNextQueued(): void {
  while (activeDiagnoses < MAX_CONCURRENT_DIAGNOSES && diagnoseQueue.length > 0) {
    const prNumber = diagnoseQueue.shift()
    if (prNumber === undefined) continue
    if (diagnoses[prNumber] !== null) continue // already resolved or cancelled while queued
    activeDiagnoses += 1
    void diagnoseOne(prNumber).finally(() => {
      activeDiagnoses -= 1
      runNextQueued()
    })
  }
}

function enqueueDiagnose(prNumber: number): void {
  diagnoses[prNumber] = null
  diagnoseQueue.push(prNumber)
  runNextQueued()
}

async function diagnoseOne(prNumber: number) {
  const controller = new AbortController()
  diagnoseControllers.set(prNumber, controller)
  try {
    const res = await fetch('/api/pull-requests/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: props.projectPath, prNumber }),
      signal: controller.signal,
    })
    if (!res.ok) return
    const data = (await res.json()) as { report: PrCheckoutReport }
    diagnoses[prNumber] = data.report
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Cancelled because the dialog closed — not a real failure, so don't
      // cache it as one. Reopening should retry this PR from scratch.
      delete diagnoses[prNumber]
    }
    // Otherwise: best-effort preview badge only — swallow, no badge shown.
    // `diagnoses[prNumber]` stays `null` from the guard above, so this PR is
    // never retried again this session.
  } finally {
    diagnoseControllers.delete(prNumber)
  }
}

/** Abort every in-flight diagnose call — used when the dialog closes. */
function abortPendingDiagnoses(): void {
  for (const controller of diagnoseControllers.values()) controller.abort()
  diagnoseControllers.clear()
  diagnoseQueue.length = 0
  activeDiagnoses = 0
}

// Genuinely lazy per-row diagnosis: only PRs actually scrolled into view get a
// `/diagnose` call, instead of firing one per row for the whole page on load
// (which, on a 25-item page, meant ~20 concurrent requests just for preview
// badges — chatty by design, and a single network hiccup failed all of them
// at once, which read as "random errors").
//
// The observer's `root` is scoped to the dialog's own scrollable section
// (not the browser viewport) with a small `rootMargin`, so only rows genuinely
// near the visible area of the list are treated as "visible" — a generous
// margin against the viewport meant a dozen+ below-the-fold rows all fired at
// once on first render, before any scrolling happened.
let rowObserver: IntersectionObserver | null = null

function ensureObserver(): IntersectionObserver {
  if (rowObserver) return rowObserver
  rowObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const prNumber = Number((entry.target as HTMLElement).dataset.prNumber)
        rowObserver?.unobserve(entry.target)
        if (Number.isFinite(prNumber) && diagnoses[prNumber] === undefined) {
          enqueueDiagnose(prNumber)
        }
      }
    },
    { root: listSectionEl.value?.$el ?? null, rootMargin: '50px' },
  )
  return rowObserver
}

/** `:ref` callback on each row — Quasar's `q-item` exposes its DOM node via `$el`. */
function registerRow(el: unknown, prNumber: number): void {
  const node = (el as { $el?: HTMLElement } | null)?.$el ?? (el as HTMLElement | null)
  if (!node || !(node instanceof HTMLElement)) return
  node.dataset.prNumber = String(prNumber)
  ensureObserver().observe(node)
}

function cancelAllRequests(): void {
  pageFetchController?.abort()
  abortPendingDiagnoses()
}

onBeforeUnmount(() => {
  cancelAllRequests()
  rowObserver?.disconnect()
  rowObserver = null
})

// The page-list fetch: only one is ever meaningful at a time (a filter/search
// change or a dialog reopen supersedes whatever was still loading), so a new
// call aborts the previous one rather than letting a stale response race in.
let pageFetchController: AbortController | null = null

async function fetchPage(cursor: string | null) {
  pageFetchController?.abort()
  const controller = new AbortController()
  pageFetchController = controller

  loading.value = true
  error.value = null
  try {
    const params = new URLSearchParams({
      projectPath: props.projectPath,
      filter: filter.value,
      search: search.value,
      perPage: '25',
    })
    if (cursor) params.set('cursor', cursor)

    const res = await fetch(`/api/pull-requests?${params.toString()}`, { signal: controller.signal })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`)
    }
    const page = data as { items: PullRequestSummary[]; nextCursor: string | null }
    if (cursor) {
      items.value = [...items.value, ...page.items]
    } else {
      items.value = page.items
    }
    nextCursor.value = page.nextCursor
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    error.value = err instanceof Error ? err.message : t('prPicker.loadFailed')
  } finally {
    if (pageFetchController === controller) loading.value = false
  }
}

function resetAndFetch() {
  items.value = []
  nextCursor.value = null
  void fetchPage(null)
}

function loadMore() {
  if (nextCursor.value === null) return
  void fetchPage(nextCursor.value)
}

function selectItem(item: PullRequestSummary) {
  if (item.isFork) return
  emit('select', item)
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      filter.value = 'all'
      search.value = ''
      resetAndFetch()
    } else {
      cancelAllRequests()
    }
  },
)

watch(filter, () => {
  if (props.modelValue) resetAndFetch()
})

watch(search, () => {
  if (props.modelValue) resetAndFetch()
})
</script>

<style scoped lang="scss">
.pr-picker__list-section {
  max-height: 60vh;
  overflow-y: auto;
}

.pr-picker__item[aria-disabled='true'] {
  opacity: 0.5;
}
</style>
