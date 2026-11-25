export default defineNuxtConfig({
  modules: ['nuxt-safe-runtime-config'],
  runtimeConfig: { apiSecret: '', webhookSecret: '', allowedOrigins: 'a,b', port: '3000', public: { apiBase: 'https://api.example.com' } },
  safeRuntimeConfig: { $schema: './schema' },
})
