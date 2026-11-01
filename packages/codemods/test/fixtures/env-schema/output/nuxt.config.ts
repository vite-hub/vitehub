import { envSchema } from '@vite-hub/env/vite';

export default defineNuxtConfig({
  extends: ['./layers/base'],
  modules: [
    'vite-hub/nuxt',
  ],
  nitro: { preset: 'cloudflare_module' },
  runtimeConfig: {
    databaseUrl: 'ignored-by-env-schema',
    keepMe: true,
  },
  vitehub: {
    preset: 'cloudflare',
    env: envSchema(new URL('./.env.example', import.meta.url), { prefix: 'NUXT_', paths: { NUXT_DATABASE_URL: 'database.url' } }),
  },
});
