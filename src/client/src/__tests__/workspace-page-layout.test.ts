import { describe, expect, it } from 'vitest'
import { workspacePageStyle } from '../utils/workspace-page-layout'

describe('workspacePageStyle', () => {
  it('retire la hauteur de la bannière PWA de la page de travail', () => {
    expect(workspacePageStyle(0, 900)).toEqual({
      height: 'calc(900px - var(--kobo-pwa-banner-height, 0px))',
      minHeight: 'calc(900px - var(--kobo-pwa-banner-height, 0px))',
    })
  })

  it('préserve le décalage du layout Quasar', () => {
    expect(workspacePageStyle(56, 900)).toEqual({
      height: 'calc(844px - var(--kobo-pwa-banner-height, 0px))',
      minHeight: 'calc(844px - var(--kobo-pwa-banner-height, 0px))',
    })
  })
})
