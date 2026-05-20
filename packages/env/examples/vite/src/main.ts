import { usePublicEnv } from '#vitehub/env/public'

const app = document.querySelector<HTMLDivElement>('#app')
const publicEnv = usePublicEnv()

if (app) {
  app.textContent = `${publicEnv.appName} ${__APP_VERSION__}`
}
