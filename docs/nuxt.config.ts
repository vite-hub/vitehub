import { defineNuxtConfig } from "nuxt/config";
import { fileURLToPath } from "node:url";

export default defineNuxtConfig({
  extends: ["docus"],
  modules: ["./modules/vitehub-docs"],
  site: {
    name: "ViteHub",
    url: "https://vitehub.dev",
  },
  llms: { domain: "https://vitehub.dev" },
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/png", href: "/favicon.png" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      ],
    },
  },
  css: ["~/assets/main.css"],
  vite: {
    resolve: {
      alias: {
        extend: fileURLToPath(new URL("./app/shims/extend.ts", import.meta.url)),
      },
    },
  },
  icon: {
    provider: "server",
    fallbackToApi: false,
    serverBundle: {
      collections: ["lucide", "simple-icons", "vscode-icons"],
    },
    clientBundle: {
      scan: true,
      icons: [
        "lucide:brain",
        "lucide:chevron-down",
        "lucide:chevron-right",
        "lucide:hash",
        "lucide:lightbulb",
        "lucide:menu",
        "lucide:moon",
        "lucide:search",
        "lucide:sun",
        "lucide:terminal",
        "lucide:text-align-start",
        "simple-icons:cloudflare",
        "simple-icons:discord",
        "simple-icons:vercel",
        "vscode-icons:file-type-typescript",
      ],
    },
  },
  devtools: {
    enabled: false,
  },
  future: {
    compatibilityVersion: 4,
  },
  compatibilityDate: "2026-05-30",
  experimental: {
    payloadExtraction: false,
    defaults: {
      nuxtLink: {
        trailingSlash: "append",
      },
    },
  },
});
