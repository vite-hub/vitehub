import { hubSchedule } from '@vite-hub/schedule/vite'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'netlify',
    agent: { invocations: false },
    blob: true,
  },
  vite: {
    plugins: [hubSchedule({ providerOutput: 'standalone' })],
  },
})
