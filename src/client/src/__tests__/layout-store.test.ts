import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useLayoutStore } from '../stores/layout'

describe('layout store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('defaults both drawers open', () => {
    const s = useLayoutStore()
    expect(s.leftDrawerOpen).toBe(true)
    expect(s.rightDrawerOpen).toBe(true)
  })

  it('toggleLeft / toggleRight flip state', () => {
    const s = useLayoutStore()
    s.toggleLeft()
    expect(s.leftDrawerOpen).toBe(false)
    s.toggleRight()
    expect(s.rightDrawerOpen).toBe(false)
    s.toggleLeft()
    expect(s.leftDrawerOpen).toBe(true)
  })

  it('setLeft / setRight set explicit values', () => {
    const s = useLayoutStore()
    s.setLeft(false)
    expect(s.leftDrawerOpen).toBe(false)
    s.setRight(false)
    expect(s.rightDrawerOpen).toBe(false)
  })

  it('applyScreenSize(true) closes both, (false) opens both', () => {
    const s = useLayoutStore()
    s.applyScreenSize(true)
    expect(s.leftDrawerOpen).toBe(false)
    expect(s.rightDrawerOpen).toBe(false)
    s.applyScreenSize(false)
    expect(s.leftDrawerOpen).toBe(true)
    expect(s.rightDrawerOpen).toBe(true)
  })
})
