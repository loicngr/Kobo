const PWA_INSTALL_BANNER_DISMISSED_KEY = 'kobo:pwa-install-banner-dismissed'

export function isPwaInstallBannerDismissed(): boolean {
  return localStorage.getItem(PWA_INSTALL_BANNER_DISMISSED_KEY) === '1'
}

export function dismissPwaInstallBanner(): void {
  localStorage.setItem(PWA_INSTALL_BANNER_DISMISSED_KEY, '1')
}
