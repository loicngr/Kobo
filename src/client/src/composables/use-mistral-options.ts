import { apiFetch } from 'src/utils/api'
import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MistralOptions, MistralSelect } from '../../../shared/mistral-options'

interface Selection {
  engine: string
  model: string
  reasoningEffort?: string
  agentPermissionMode: string
  workspaceId?: string
  projectPath?: string
  enabled?: boolean
}

/** Native choices belong to this exact context/model/mode and dialog lifetime. */
export function useMistralOptions(selection: () => Selection) {
  const { t } = useI18n()
  const data = ref<MistralOptions>()
  const loading = ref(false)
  const failed = ref(false)
  let request: AbortController | undefined
  const scope = computed(() => {
    const input = selection()
    return JSON.stringify([
      input.engine,
      input.workspaceId,
      input.projectPath,
      input.model,
      input.agentPermissionMode,
      input.enabled,
    ])
  })
  async function refresh() {
    request?.abort()
    request = undefined
    data.value = undefined
    loading.value = false
    failed.value = false
    const input = selection()
    if (input.engine !== 'mistral-vibe' || input.enabled === false) return
    const identity = scope.value
    const controller = new AbortController()
    request = controller
    loading.value = true
    // Catalogue discovery does not change the form permission or launch an agent turn.
    const permission = input.agentPermissionMode === 'plan' ? 'interactive' : input.agentPermissionMode
    const params = new URLSearchParams({ model: input.model, agentPermissionMode: permission })
    if (input.workspaceId) params.set('workspaceId', input.workspaceId)
    else if (input.projectPath) params.set('projectPath', input.projectPath)
    try {
      const options = await apiFetch<MistralOptions>(`/api/engines/mistral-vibe/options?${params}`, {
        signal: controller.signal,
        timeoutMs: 90_000,
      })
      if (request !== controller || controller.signal.aborted || identity !== scope.value) return
      data.value = options
    } catch {
      if (request !== controller || controller.signal.aborted || identity !== scope.value) return
      failed.value = true
    } finally {
      if (request === controller) loading.value = false
    }
  }
  watch(
    scope,
    () => {
      void refresh()
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => {
    request?.abort()
    request = undefined
  })
  const unavailable = (value: string | undefined, select: MistralSelect | undefined) =>
    !!value && value !== 'auto' && !!data.value && !select?.options.some((option) => option.value === value)
  const choices = (value: string | undefined, select: MistralSelect | undefined) => {
    const result = [
      { value: 'auto', label: t('model.auto'), description: t('model.mistralAutoDescription'), disable: false },
      ...(select?.options ?? []).map((option) => ({
        value: option.value,
        label: option.group ? `${option.group} · ${option.name}` : option.name,
        description: option.description ?? '',
        disable: false,
      })),
    ]
    if (value && !result.some((option) => option.value === value))
      result.push({
        value,
        label: value,
        description: data.value ? t('engine.mistralSelectionUnavailable') : '',
        disable: true,
      })
    return result
  }
  return reactive({
    models: computed(() => choices(selection().model, data.value?.model)),
    efforts: computed(() => choices(selection().reasoningEffort, data.value?.thinking)),
    loading,
    message: computed(() =>
      loading.value
        ? t('engine.mistralOptionsLoading')
        : failed.value
          ? t('engine.mistralOptionsError')
          : unavailable(selection().model, data.value?.model) ||
              unavailable(selection().reasoningEffort, data.value?.thinking)
            ? t('engine.mistralSelectionUnavailable')
            : '',
    ),
    refresh,
  })
}
