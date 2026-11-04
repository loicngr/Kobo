import { installNotificationNavigation } from 'src/utils/notification-navigation'
import { defineBoot } from '#q-app'

export default defineBoot(({ router }) => {
  installNotificationNavigation(router)
})
