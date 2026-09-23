import { beforeEach, describe, expect, it } from 'vitest'
import { dismissPwaInstallBanner, isPwaInstallBannerDismissed } from '../utils/pwa-install-banner'

describe('PWA install banner preference', () => {
  beforeEach(() => localStorage.clear())

  it('remains dismissed after the page is reloaded', () => {
    expect(isPwaInstallBannerDismissed()).toBe(false)
    dismissPwaInstallBanner()
    expect(isPwaInstallBannerDismissed()).toBe(true)
  })
})
