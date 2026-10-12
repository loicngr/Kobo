import { usePointerResize } from 'src/composables/use-pointer-resize'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

function setup() {
  const scope = effectScope()
  scopes.push(scope)
  const resize = scope.run(usePointerResize)!
  const move = vi.fn()
  const end = vi.fn()
  return { scope, resize, move, end }
}

function pointer(type: string, options: PointerEventInit = {}) {
  return new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, ...options })
}

describe('pointer resize', () => {
  it.each(['touch', 'mouse', 'pen'])('resizes with %s and ignores other fingers', (pointerType) => {
    const { resize, move, end } = setup()
    resize(pointer('pointerdown', { pointerType }), { cursor: 'col-resize', move, end })
    document.dispatchEvent(pointer('pointermove', { pointerType, clientX: 340 }))
    document.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 999 }))
    document.dispatchEvent(pointer('pointerup', { pointerId: 2 }))
    expect(move).toHaveBeenCalledTimes(1)
    expect(move.mock.calls[0]?.[0].clientX).toBe(340)
    expect(end).not.toHaveBeenCalled()
    document.dispatchEvent(pointer('pointerup'))
    expect(end).toHaveBeenCalledOnce()
    document.dispatchEvent(pointer('pointermove'))
    expect(move).toHaveBeenCalledTimes(1)
  })

  it.each(['pointercancel', 'blur'])('cleans up on %s and restores pre-existing styles', (type) => {
    const { resize, move, end } = setup()
    document.body.style.cursor = 'wait'
    document.body.style.userSelect = 'text'
    resize(pointer('pointerdown'), { cursor: 'row-resize', move, end })
    if (type === 'blur') window.dispatchEvent(new Event('blur'))
    else document.dispatchEvent(pointer(type))
    expect(end).toHaveBeenCalledOnce()
    expect(document.body.style.cursor).toBe('wait')
    expect(document.body.style.userSelect).toBe('text')
    document.dispatchEvent(pointer('pointermove'))
    expect(move).not.toHaveBeenCalled()
  })

  it('removes listeners on unmount without saving an unfinished gesture', () => {
    const { scope, resize, move, end } = setup()
    resize(pointer('pointerdown'), { cursor: 'col-resize', move, end })
    scope.stop()
    document.dispatchEvent(pointer('pointermove'))
    document.dispatchEvent(pointer('pointerup'))
    expect(move).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
    expect(document.body.style.userSelect).toBe('')
  })

  it('ignores secondary pointers and mouse buttons', () => {
    const { resize, move, end } = setup()
    resize(pointer('pointerdown', { button: 2 }), { cursor: 'col-resize', move, end })
    resize(pointer('pointerdown', { isPrimary: false }), { cursor: 'col-resize', move, end })
    document.dispatchEvent(pointer('pointermove'))
    document.dispatchEvent(pointer('pointerup'))
    expect(move).not.toHaveBeenCalled()
    expect(end).not.toHaveBeenCalled()
  })
})
