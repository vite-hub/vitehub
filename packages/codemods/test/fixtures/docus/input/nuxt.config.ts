export default defineNuxtConfig({
  extends: ['docus'],
  site: {
    name: 'Tide Charts',
  },
  llms: {
    domain: 'https://tides.example.dev',
  },
  compatibilityDate: '2026-09-03',
})
