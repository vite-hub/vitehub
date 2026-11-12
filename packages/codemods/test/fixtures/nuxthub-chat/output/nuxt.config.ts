// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@comark/nuxt',
    'vite-hub/nuxt',
    'nuxt-auth-utils',
    'nuxt-csurf'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  experimental: {
    viewTransition: true
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    experimental: {
      openAPI: true
    }
  },

  vitehub: {
    preset: 'node',
    database: true,
    blob: true
  },

  vite: {
    optimizeDeps: {
      include: ['striptags']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
