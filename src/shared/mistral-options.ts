/** Bounded projection of native ACP configuration; Auto is a Kōbō-only sentinel. */
export interface MistralOption {
  value: string
  name: string
  description?: string
  group?: string
}
export interface MistralSelect {
  currentValue: string
  options: MistralOption[]
}
export interface MistralOptions {
  model: MistralSelect
  thinking: MistralSelect
}
