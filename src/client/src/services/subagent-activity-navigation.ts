import type { AgentEventOrigin } from 'src/types/agent-event'
import type { InjectionKey, Ref } from 'vue'

export interface SubagentActivityTarget {
  origin: AgentEventOrigin
}

export const openSubagentActivityKey: InjectionKey<(target: SubagentActivityTarget) => void> =
  Symbol('openSubagentActivity')
export const subagentActivityTargetKey: InjectionKey<Ref<SubagentActivityTarget | null>> =
  Symbol('subagentActivityTarget')
