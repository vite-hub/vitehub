export default defineNuxtConfig({
  extends: ['./layers/base'],
  modules: [
    ['nuxt-safe-runtime-config', {
      envSchema: {
        file: '.env.example',
        paths: {
          NUXT_DATABASE_URL: 'database.url',
          NUXT_PUBLIC_POSTHOG_REPLAY_SAMPLE_RATE: 'public.posthog.replaySampleRate',
        },
      },
    }],
  ],
  nitro: { preset: 'cloudflare_module' },
  runtimeConfig: {
    databaseUrl: 'ignored-by-env-schema',
    keepMe: true,
  },
});
