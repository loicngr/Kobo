import { ref } from 'vue'

/** Reactive flag controlling the network login dialog (decouples boot from the component). */
export const networkLoginOpen = ref(false)

export function openNetworkLogin(): void {
  networkLoginOpen.value = true
}

export function closeNetworkLogin(): void {
  networkLoginOpen.value = false
}
