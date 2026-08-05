<template>
  <Teleport to="body">
    <div
      ref="overlayRef"
      class="whip-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="t('whip.overlayLabel')"
      aria-describedby="whip-overlay-instructions"
      tabindex="-1"
      @keydown="handleKeydown"
    >
      <span id="whip-overlay-instructions" class="q-sr-only">{{ t('whip.overlayInstructions') }}</span>
      <canvas ref="canvasRef" class="whip-canvas" aria-hidden="true" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { playWhipCrack } from 'src/utils/whip-audio'
import { createWhip, dropWhip, stepWhip, WHIP_CONFIG, type WhipPoint, type WhipState } from 'src/utils/whip-physics'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  soundEnabled: boolean
  soundVolume: number
}>()

const emit = defineEmits<{
  crack: []
  closed: []
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const overlayRef = ref<HTMLElement | null>(null)
const { t } = useI18n()
const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
let context: CanvasRenderingContext2D | null = null
let state: WhipState | null = null
let animationFrame: number | null = null
let previousFocusedElement: HTMLElement | null = null

function resizeCanvas(): void {
  const canvas = canvasRef.value
  if (!canvas || !context) return
  const ratio = Math.max(1, window.devicePixelRatio || 1)
  canvas.width = Math.round(window.innerWidth * ratio)
  canvas.height = Math.round(window.innerHeight * ratio)
  canvas.style.width = `${window.innerWidth}px`
  canvas.style.height = `${window.innerHeight}px`
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

function traceSmoothPath(ctx: CanvasRenderingContext2D, points: readonly WhipPoint[]): void {
  const first = points[0]
  if (!first) return
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!
    const next = points[index + 1]!
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
  }
  const last = points.at(-1)
  if (last) ctx.lineTo(last.x, last.y)
}

function drawWhip(): void {
  if (!context || !state) return
  context.clearRect(0, 0, window.innerWidth, window.innerHeight)
  context.lineCap = 'round'
  context.lineJoin = 'round'

  traceSmoothPath(context, state.points)
  context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  context.lineWidth = 11
  context.stroke()

  for (let index = 0; index < state.points.length - 1; index += 1) {
    const start = state.points[index]!
    const end = state.points[index + 1]!
    const progress = index / Math.max(1, state.points.length - 2)
    context.beginPath()
    context.moveTo(start.x, start.y)
    context.lineTo(end.x, end.y)
    context.strokeStyle = '#15151d'
    context.lineWidth = 8 - progress * 4
    context.stroke()
  }
}

function emitCrack(): void {
  playWhipCrack({ enabled: props.soundEnabled, volume: props.soundVolume })
  emit('crack')
}

function animate(now: number): void {
  if (!state) return
  const result = stepWhip(state, {
    pointer,
    bounds: { width: window.innerWidth, height: window.innerHeight },
    now,
  })
  drawWhip()
  if (result.cracked) emitCrack()
  if (result.offscreen) {
    emit('closed')
    return
  }
  animationFrame = requestAnimationFrame(animate)
}

function handlePointerMove(event: PointerEvent): void {
  pointer.x = event.clientX
  pointer.y = event.clientY
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !state) return
  dropWhip(state)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('closed')
    return
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    overlayRef.value?.focus()
    return
  }

  const isSpace = event.key === ' '
  if (isSpace) event.preventDefault()
  if (event.repeat || (event.key !== 'Enter' && !isSpace)) return

  const now = performance.now()
  if (state && now - state.lastCrackAt < WHIP_CONFIG.crackCooldownMs) return

  if (!isSpace) event.preventDefault()
  if (state) state.lastCrackAt = now
  emitCrack()
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('closed')
}

onMounted(() => {
  previousFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const canvas = canvasRef.value
  if (!canvas) return
  context = canvas.getContext('2d')
  if (!context) {
    emit('closed')
    return
  }
  resizeCanvas()
  state = createWhip(pointer, performance.now())
  canvas.addEventListener('pointermove', handlePointerMove)
  canvas.addEventListener('pointerdown', handlePointerDown)
  window.addEventListener('resize', resizeCanvas)
  document.addEventListener('keydown', handleDocumentKeydown)
  animationFrame = requestAnimationFrame(animate)
  overlayRef.value?.focus()
})

onBeforeUnmount(() => {
  const canvas = canvasRef.value
  canvas?.removeEventListener('pointermove', handlePointerMove)
  canvas?.removeEventListener('pointerdown', handlePointerDown)
  window.removeEventListener('resize', resizeCanvas)
  document.removeEventListener('keydown', handleDocumentKeydown)
  if (animationFrame !== null) cancelAnimationFrame(animationFrame)
  if (previousFocusedElement?.isConnected) previousFocusedElement.focus()
})
</script>

<style lang="scss">
.whip-overlay {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 10000;
  cursor: none;
  touch-action: none;
}

.whip-canvas {
  display: block;
}
</style>
