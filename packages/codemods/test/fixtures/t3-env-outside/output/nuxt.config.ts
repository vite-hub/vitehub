import { env } from "vite-hub/env";

export default defineNuxtConfig({
  vitehub: {
    host: "cloudflare",
    env: {
      server: {
        databaseUrl: env({ secret: true, source: env.source("DATABASE_URL") }),
        betterAuthSecret: env({ secret: true, source: env.source("BETTER_AUTH_SECRET") }),
      },
    },
  },
  modules: ["vite-hub/nuxt"],
});
