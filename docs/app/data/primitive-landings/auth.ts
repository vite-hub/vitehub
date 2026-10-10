import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const authDefinition: PrimitiveProjectFile = {
  path: "server/auth.ts",
  language: "typescript",
  content: `import { defineAuth } from "vite-hub/auth"

export default defineAuth({
  appName: "Acme",
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
  plugins: [vitehub({ preset: "node", auth: true })],
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
          content: `// Install: pnpm add vite-hub better-auth vite nitro@3.0.260903-beta
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node", auth: true }),
    // Nitro's prerelease plugin has a separate Vite type identity.
    nitro() as never,
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
          content: `// Install: pnpm add vite-hub better-auth nuxt@^4.5.2
import { defineNuxtConfig } from "nuxt/config"
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [[viteHubNuxt, { preset: "node", auth: true }]],
})`,
        },
        authDefinition,
      ],
    },
  ],
} satisfies PrimitiveLanding;
