import { i18n } from 'src/i18n'
import { defineBoot } from '#q-app/wrappers'

export default defineBoot(({ app }) => {
  app.use(i18n)
})
