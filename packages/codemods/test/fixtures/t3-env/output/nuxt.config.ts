import { env } from "vite-hub/env";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/ui", "vite-hub/nuxt"],
  vitehub: {
    host: "node",
    env: {
      public: {
        appUrl: env({ mode: "build", source: env.source("NUXT_PUBLIC_APP_URL") }),
      },
      server: {
        nodeEnv: env.enum(["development", "production"], { default: "development", source: env.source("NODE_ENV") }),
        databaseUrl: env({ secret: true, source: env.source("DATABASE_URL") }),
        smtpPort: env.number({ source: env.source("SMTP_PORT") }),
        smtpPass: env({ secret: true, source: env.source("SMTP_PASS") }),
        mockEmail: env({ optional: true, source: env.source("MOCK_EMAIL") }),
        timeout: env({ source: env.source("TIMEOUT") }),
      },
    },
  },
});
