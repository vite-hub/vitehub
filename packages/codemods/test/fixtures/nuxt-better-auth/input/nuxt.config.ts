export default defineNuxtConfig({
  modules: ['@nuxthub/core', '@nuxtjs/better-auth', '@nuxt/ui'],

  routeRules: {
    '/': { auth: { only: 'guest', redirectTo: '/dashboard' } },
    '/dashboard/**': { auth: 'user' },
    '/admin': { auth: { only: 'user', user: { role: 'admin' } } },
    '/api/notes/**': { auth: 'user' },
    '/blog/**': { prerender: true },
  },

  hub: {
    db: 'sqlite',
  },

  auth: {
    redirects: {
      login: '/sign-in',
      guest: '/dashboard',
      logout: '/',
    },
    preserveRedirect: true,
  },

  compatibilityDate: '2026-09-03',
})
