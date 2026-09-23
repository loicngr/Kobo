import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { MAX_CUSTOM_SOUND_BYTES } from '../../../shared/notification-assets'
import CustomSoundManager from '../components/CustomSoundManager.vue'
import en from '../i18n/en'

const { api, played } = vi.hoisted(() => ({ api: vi.fn(), played: vi.fn() }))
vi.mock('../utils/api', async () => {
  const actual = await vi.importActual<typeof import('../utils/api')>('../utils/api')
  return { ...actual, apiFetch: api }
})
vi.mock('../utils/notifications', () => ({ playNotificationSound: played }))

const { ApiError } = await import('../utils/api')
const { setKnownCustomSoundIds, soundUrl } = await import('../utils/notification-sounds')

const SOUND = {
  id: 'abcdef123456',
  name: 'alert.wav',
  extension: '.wav',
  size: 2048,
  createdAt: '2026-09-23T12:00:00.000Z',
  reference: 'custom:abcdef123456',
}

const Button = defineComponent({
  props: ['label', 'disable', 'icon'],
  emits: ['click'],
  setup:
    (p, { emit }) =>
    () =>
      h('button', { disabled: p.disable, 'data-icon': p.icon, onClick: () => emit('click') }, p.label),
})
const Passthrough = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('div', slots.default?.()),
})

function setup() {
  return mount(CustomSoundManager, {
    attachTo: document.body,
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })],
      stubs: {
        QBtn: Button,
        QList: Passthrough,
        QItem: Passthrough,
        QItemSection: Passthrough,
        QItemLabel: Passthrough,
      },
    },
  })
}

function select(wrapper: ReturnType<typeof setup>, file: File) {
  const input = wrapper.find('[data-test="custom-sound-input"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  return input.trigger('change')
}

function iconButton(wrapper: ReturnType<typeof setup>, icon: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.attributes('data-icon') === icon)
  if (!button) throw new Error(`No button with icon ${icon}`)
  return button
}

beforeEach(() => {
  setActivePinia(createPinia())
  setKnownCustomSoundIds([])
  vi.resetAllMocks()
  // The store preloads each sound's bytes through the wrapped global fetch to
  // obtain a blob URL. Stubbed so no test reaches the network.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  vi.stubGlobal(
    'URL',
    Object.assign(Object.create(URL), URL, {
      createObjectURL: vi.fn(() => 'blob:kobo/test'),
      revokeObjectURL: vi.fn(),
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

it('lists the imported sounds on mount', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] })
  const wrapper = setup()
  await flushPromises()
  expect(api).toHaveBeenCalledWith('/api/sounds')
  expect(wrapper.text()).toContain('alert.wav')
})

it('uploads the picked file and makes it resolvable right away', async () => {
  api.mockResolvedValueOnce({ sounds: [] }).mockResolvedValueOnce(SOUND)
  const wrapper = setup()
  await flushPromises()
  await select(wrapper, new File([new Uint8Array(8)], 'alert.wav', { type: 'audio/wav' }))
  await flushPromises()

  const [url, options] = api.mock.calls[1] as [string, { method: string; body: FormData }]
  expect(url).toBe('/api/sounds')
  expect(options.method).toBe('POST')
  expect((options.body.get('sound') as File).name).toBe('alert.wav')
  expect(wrapper.text()).toContain('alert.wav')
  expect(soundUrl(SOUND.reference)).toBe('/api/sounds/abcdef123456/file')
})

it('clears the input so the same file can be picked again', async () => {
  api.mockResolvedValueOnce({ sounds: [] }).mockResolvedValueOnce(SOUND)
  const wrapper = setup()
  await flushPromises()
  await select(wrapper, new File([new Uint8Array(8)], 'alert.wav', { type: 'audio/wav' }))
  await flushPromises()
  expect((wrapper.find('[data-test="custom-sound-input"]').element as HTMLInputElement).value).toBe('')
})

it('translates a rejected format instead of showing a raw error', async () => {
  api.mockResolvedValueOnce({ sounds: [] }).mockRejectedValueOnce(new ApiError('Invalid sound file', 400, 'type', ''))
  const wrapper = setup()
  await flushPromises()
  await select(wrapper, new File([new Uint8Array(8)], 'clip.flac', { type: '' }))
  await flushPromises()
  expect(wrapper.find('[role="alert"]').text()).toBe(en['settings.customSoundsError.type'])
})

it('removes a sound and stops resolving it', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] }).mockResolvedValueOnce(null)
  const wrapper = setup()
  await flushPromises()
  await iconButton(wrapper, 'delete').trigger('click')
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith(`/api/sounds/${SOUND.id}`, { method: 'DELETE' })
  expect(wrapper.text()).not.toContain('alert.wav')
  expect(soundUrl(SOUND.reference)).toBe('/sounds/neutral.wav')
})

it('previews a sound through the shared player', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] })
  const wrapper = setup()
  await flushPromises()
  await iconButton(wrapper, 'play_arrow').trigger('click')
  expect(played).toHaveBeenCalledWith(SOUND.reference, 1)
})

it('refuses an oversized file locally instead of spending the upload', async () => {
  api.mockResolvedValueOnce({ sounds: [] })
  const wrapper = setup()
  await flushPromises()
  const big = new File([new Uint8Array(8)], 'big.wav', { type: 'audio/wav' })
  Object.defineProperty(big, 'size', { value: MAX_CUSTOM_SOUND_BYTES + 1 })
  await select(wrapper, big)
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(1)
  expect(wrapper.find('[role="alert"]').text()).toBe(
    en['settings.customSoundsError.size'].replace('{size}', String(MAX_CUSTOM_SOUND_BYTES / 1024 / 1024)),
  )
})

it('refuses an unsupported extension locally', async () => {
  api.mockResolvedValueOnce({ sounds: [] })
  const wrapper = setup()
  await flushPromises()
  await select(wrapper, new File([new Uint8Array(8)], 'clip.flac', { type: 'audio/flac' }))
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(1)
  expect(wrapper.find('[role="alert"]').text()).toBe(en['settings.customSoundsError.type'])
})

it('reports a body-limit rejection as a size problem, not a generic failure', async () => {
  api.mockResolvedValueOnce({ sounds: [] }).mockRejectedValueOnce(new ApiError('Payload Too Large', 413, undefined, ''))
  const wrapper = setup()
  await flushPromises()
  await select(wrapper, new File([new Uint8Array(8)], 'alert.wav', { type: 'audio/wav' }))
  await flushPromises()
  expect(wrapper.find('[role="alert"]').text()).toBe(
    en['settings.customSoundsError.size'].replace('{size}', String(MAX_CUSTOM_SOUND_BYTES / 1024 / 1024)),
  )
})

// Regression: the removal used to run in a `finally`, so a 500 or a dropped
// connection hid a sound that still existed and still counted against the limit.
it('keeps a sound listed when its deletion fails', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] }).mockRejectedValueOnce(new ApiError('boom', 500, undefined, ''))
  const wrapper = setup()
  await flushPromises()
  await iconButton(wrapper, 'delete').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('alert.wav')
  expect(wrapper.find('[role="alert"]').text()).toBe(en['settings.customSoundsError.failed'])
})

it('drops a sound the server no longer knows', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] }).mockRejectedValueOnce(new ApiError('gone', 404, undefined, ''))
  const wrapper = setup()
  await flushPromises()
  await iconButton(wrapper, 'delete').trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain('alert.wav')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

// Regression: a media element sends no X-Kobo-Token, so the API URL answers 401
// over LAN access. The catalogue is preloaded into blob URLs instead.
it('plays an imported sound from a preloaded blob URL', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] })
  ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    blob: async () => new Blob([new Uint8Array(8)], { type: 'audio/wav' }),
  })
  setup()
  await flushPromises()
  expect(globalThis.fetch).toHaveBeenCalledWith('/api/sounds/abcdef123456/file')
  expect(soundUrl(SOUND.reference)).toBe('blob:kobo/test')
})

it('keeps the API URL when the preload fails', async () => {
  api.mockResolvedValueOnce({ sounds: [SOUND] })
  setup()
  await flushPromises()
  expect(soundUrl(SOUND.reference)).toBe('/api/sounds/abcdef123456/file')
})
