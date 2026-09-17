import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import type { SessionHandoff } from '../../../shared/session-handoff'
import { useSessionHandoff } from '../composables/use-session-handoff'
import { useSessionHandoffStore } from '../stores/session-handoff'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

it('loads the selected workspace, polls only active handoffs and stops on completion or unmount', async () => {
  const id = ref<string | null>('ws-1')
  const store = useSessionHandoffStore()
  const refresh = vi.spyOn(store, 'refresh').mockResolvedValue()
  const view = mount(
    defineComponent({
      setup() {
        useSessionHandoff(id)
        return () => null
      },
    }),
  )
  await flushPromises()
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5000)
  expect(refresh).toHaveBeenCalledTimes(1)
  store.current['ws-1'] = { state: 'generating' } as SessionHandoff
  await nextTick()
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(2)
  store.current['ws-1']!.state = 'completed'
  await nextTick()
  await vi.advanceTimersByTimeAsync(5000)
  expect(refresh).toHaveBeenCalledTimes(2)
  id.value = 'ws-2'
  await flushPromises()
  expect(refresh).toHaveBeenLastCalledWith('ws-2')
  store.current['ws-2'] = { state: 'stopping' } as SessionHandoff
  await nextTick()
  view.unmount()
  await vi.advanceTimersByTimeAsync(5000)
  expect(refresh).toHaveBeenCalledTimes(3)
})
