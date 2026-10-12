import { onScopeDispose } from 'vue'

interface ResizeGesture {
  cursor: 'col-resize' | 'row-resize'
  move: (event: PointerEvent) => void
  end: () => void
}

/** One resize gesture at a time, shared by mouse, pen and touch handles. */
export function usePointerResize() {
  let cleanup: (() => void) | undefined
  onScopeDispose(() => cleanup?.())

  return (event: PointerEvent, gesture: ResizeGesture) => {
    if (!event.isPrimary || event.button !== 0 || cleanup) return
    event.preventDefault()
    event.stopPropagation()
    const pointerId = event.pointerId
    const target = event.currentTarget as HTMLElement | null
    const { cursor, userSelect } = document.body.style

    const move = (next: PointerEvent) => {
      if (next.pointerId === pointerId) gesture.move(next)
    }
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      blur()
    }
    const blur = () => {
      cleanup?.()
      gesture.end()
    }
    cleanup = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      target?.removeEventListener('lostpointercapture', finish)
      window.removeEventListener('blur', blur)
      if (target?.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
      cleanup = undefined
    }
    document.body.style.cursor = gesture.cursor
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
    target?.addEventListener('lostpointercapture', finish)
    window.addEventListener('blur', blur)
    target?.setPointerCapture(pointerId)
  }
}
