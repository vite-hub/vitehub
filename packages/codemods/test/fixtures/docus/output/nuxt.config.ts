export default defineNuxtConfig({
  compatibilityDate: '2026-09-03',
  modules: ['@vite-hub/docs/nuxt'],
  docs: {
    site: { name: 'Tide Charts', url: 'https://tides.example.dev', description: 'Tide tables for every harbor, as a Vue component.' },
    github: { repo: 'tide-charts/tide-charts', branch: 'main', dir: 'docs/content' },
    socials: [
      { label: 'Discord', icon: 'i-simple-icons-discord', to: 'https://chat.tides.example.dev' },
    ],
  },
})
