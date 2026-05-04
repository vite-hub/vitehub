import buildConfig from 'virtual:@vitehub/env/build'

const app = document.querySelector<HTMLDivElement>('#app')

if (app) {
  app.textContent = `${buildConfig.public.appName} ${__APP_VERSION__}`
}
