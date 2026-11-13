import type { PrimitiveLanding, PrimitiveProjectFile } from "./types";

const page: PrimitiveProjectFile = {
  path: "app/app.vue",
  language: "vue",
  content: `<template>
  <h1>{{ t\`Deploy your agent\` }}</h1>
  <p><Trans>Read the <a href="/docs">docs</a> first.</Trans></p>
</template>`,
};

const route: PrimitiveProjectFile = {
  path: "server/api/greeting.ts",
  language: "typescript",
  content: `import { defineEventHandler } from "h3"
import { getLocale, t } from "vite-hub/i18n"

export default defineEventHandler(() => ({
  locale: getLocale(),
  message: t\`Payment received\`,
}))`,
};

export const I18nLanding = {
  slug: "i18n",
  name: "i18n",
  docsTo: "/docs/i18n",
  eyebrow: "ViteHub i18n",
  description: "Write the app in your language with no message keys. ViteHub collects the messages for translators and serves each request in its own locale.",
  tagline: "Write the text. Ship every language.",
  accent: "info",
  supported: ["Nitro", "Nuxt"],
  variants: [
    {
      framework: "nitro",
      label: "Nitro",
      files: [
        {
          path: "vite.config.ts",
          language: "typescript",
          content: `// Install: pnpm add vite-hub @vite-hub/i18n vue nitro@3.0.261102-rc h3@2.0.8 && pnpm add -D @vitejs/plugin-vue
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vue(),
    vitehub({ host: "node", i18n: { locales: ["en", "es"] } }),
  ],
})`,
        },
        {
          path: "src/main.ts",
          language: "typescript",
          content: `import { createApp } from "vue"
import { createI18n } from "vite-hub/i18n/vue"
import App from "./App.vue"

createApp(App).use(await createI18n()).mount("#app")`,
        },
        { ...page, path: "src/App.vue" },
        route,
      ],
    },
    {
      framework: "nuxt",
      label: "Nuxt",
      files: [
        {
          path: "nuxt.config.ts",
          language: "typescript",
          content: `// Nuxt 5. Install: pnpm add vite-hub @vite-hub/i18n nuxt@npm:nuxt-nightly@5x
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [[viteHubNuxt, { host: "node", i18n: { locales: ["en", "es"] } }]],
})`,
        },
        page,
        route,
      ],
    },
  ],
} satisfies PrimitiveLanding;
