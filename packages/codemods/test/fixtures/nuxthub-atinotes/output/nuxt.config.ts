// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    'vite-hub/nuxt',
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

  vitehub: {
    host: 'cloudflare',
    kv: { driver: 'cloudflare-kv-binding', binding: 'KV', namespaceId: '2d0205a5567844e2bdc0db9ea926f7e9' }
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
