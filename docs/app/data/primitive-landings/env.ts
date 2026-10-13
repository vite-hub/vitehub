import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

const startingLayout = stubLanding("env", "Env", "/docs/env");

export const EnvLanding = {
  ...startingLayout,
  eyebrow: "ViteHub Env",
  description: "Declare and inspect typed environment configuration before a host starts serving traffic.",
  tagline: "Configuration you can inspect before it fails.",
  accent: "info",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: startingLayout.variants.map((variant) => ({
    ...variant,
    files: [
      {
        path: variant.framework === "nuxt" ? "nuxt.config.ts" : "vite.config.ts",
        language: "typescript",
        content: variant.framework === "nuxt"
          ? `// Illustrative pseudocode: configure your deployment preset for production.
import { env } from '@vite-hub/env/vite'
import viteHubNuxt from 'vite-hub/nuxt'

export default defineNuxtConfig({
  modules: [viteHubNuxt],
  vitehub: {
    preset: 'node',
    env: {
      server: {
        dryRun: env.boolean({ default: true }),
        apiKey: env({ secret: true, source: env.source('API_KEY') }),
      },
    },
  },
})`
          : variant.framework === "nitro"
            ? `// Illustrative pseudocode: Nitro serves the generated Server Env module.
import { createEnvImportAliases, env, hubEnv } from '@vite-hub/env/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv(), nitro()],
  nitro: {
    alias: createEnvImportAliases(),
  },
  env: {
    server: {
      dryRun: env.boolean({ default: true }),
      apiKey: env({ secret: true, source: env.source('API_KEY') }),
    },
  },
})`
            : `// Illustrative pseudocode: compose this Env configuration with your host setup.
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    server: {
      dryRun: env.boolean({ default: true }),
      apiKey: env({ secret: true, source: env.source('API_KEY') }),
    },
  },
})`,
      },
      {
        path: "server/config.ts",
        language: "typescript",
        content: `import { useServerEnv } from '#vitehub/env/server'

export function isDryRun() {
  const { dryRun } = useServerEnv()
  return dryRun
}`,
      },
    ],
  })),
} satisfies PrimitiveLanding;
