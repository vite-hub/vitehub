// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxthub/core',
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/mdc',
    'nuxt-og-image',
    'nuxt-auth-utils',
    '@nuxtjs/plausible'
  ],

  devtools: {
    enabled: true
  },
  css: ['~/assets/css/main.css'],

  mdc: {
    highlight: {
      theme: {
        default: 'vitesse-light',
        dark: 'material-theme-palenight'
      }
    }
  },

  ui: {
    content: true
  },

  routeRules: {
    // Used for notes.atinux.com
    // Fell free to remove it
    '/nuxt-custom-fetch': { redirect: { to: 'https://nuxt.com/docs/guide/recipes/custom-usefetch', statusCode: 302 } }
  },
  future: { compatibilityVersion: 4 },
  compatibilityDate: '2025-12-10',

  hub: {
    kv: true
  },

  eslint: {
    config: {
      stylistic: {
        quotes: 'single',
        commaDangle: 'never'
      }
    }
  },

  ogImage: {
    compatibility: {
      runtime: {
        resvg: 'wasm'
      }
    }
  }
})
