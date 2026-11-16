import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const authDefinition: PrimitiveProjectFile = {
  path: "server/auth.ts",
  language: "typescript",
  content: `import { defineAuth } from "vite-hub/auth"
import { authDatabase } from "vite-hub/auth/database"

export default defineAuth({
  appName: "Acme",
  database: authDatabase(),
  emailAndPassword: { enabled: true },
})`,
};

export const AuthLanding = {
  slug: "auth",
  name: "Auth",
  docsTo: "/docs/auth",
  eyebrow: "ViteHub Auth",
  description: "Build sessions and providers with Better Auth while keeping the server contract portable.",
  tagline: "Authentication that stays yours across hosts.",
  accent: "primary",
  supported: ["Better Auth", "Vite", "Nitro", "Nuxt"],
  variants: [
    {
      framework: "vite",
      label: "Vite",
      files: [
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `// Install: pnpm add vite-hub better-auth vite
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [vitehub({ host: "node", auth: true })],
})`,
        },
        authDefinition,
      ],
    },
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `// Install: pnpm add vite-hub better-auth vite nitro@3.0.261102-rc
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ host: "node", auth: true }),
    nitro(),
  ],
})`,
        },
        authDefinition,
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `// Use pnpm 11.5 or newer for the Nuxt 5 nightly alias.
// Install: pnpm add vite-hub better-auth nuxt@npm:nuxt-nightly@5x
import { defineNuxtConfig } from "nuxt/config"
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [[viteHubNuxt, { host: "node", auth: true }]],
})`,
        },
        authDefinition,
      ],
    },
  ],
} satisfies PrimitiveLanding;
