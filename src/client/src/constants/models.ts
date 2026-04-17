export const MODEL_IDS = {
  AUTO: 'auto',
  OPUS_47_CLASSIC: 'claude-opus-4-7',
  OPUS_47_1M: 'claude-opus-4-7[1m]',
  OPUS_CLASSIC: 'claude-opus-4-6',
  OPUS_1M: 'claude-opus-4-6[1m]',
  SONNET_CLASSIC: 'claude-sonnet-4-6',
  SONNET_1M: 'claude-sonnet-4-6[1m]',
  HAIKU: 'claude-haiku-4-5-20251001',
} as const

export const MODEL_OPTION_DEFS = [
  { i18nLabelKey: 'model.auto', value: MODEL_IDS.AUTO, i18nDescriptionKey: 'model.autoDescription' },
  {
    i18nLabelKey: 'model.opus47Classic',
    value: MODEL_IDS.OPUS_47_CLASSIC,
    i18nDescriptionKey: 'model.opus47ClassicDescription',
  },
  { i18nLabelKey: 'model.opus471m', value: MODEL_IDS.OPUS_47_1M, i18nDescriptionKey: 'model.opus471mDescription' },
  {
    i18nLabelKey: 'model.opusClassic',
    value: MODEL_IDS.OPUS_CLASSIC,
    i18nDescriptionKey: 'model.opusClassicDescription',
  },
  { i18nLabelKey: 'model.opus1m', value: MODEL_IDS.OPUS_1M, i18nDescriptionKey: 'model.opus1mDescription' },
  {
    i18nLabelKey: 'model.sonnetClassic',
    value: MODEL_IDS.SONNET_CLASSIC,
    i18nDescriptionKey: 'model.sonnetClassicDescription',
  },
  { i18nLabelKey: 'model.sonnet1m', value: MODEL_IDS.SONNET_1M, i18nDescriptionKey: 'model.sonnet1mDescription' },
  { i18nLabelKey: 'model.haiku', value: MODEL_IDS.HAIKU, i18nDescriptionKey: 'model.haikuDescription' },
] as const
