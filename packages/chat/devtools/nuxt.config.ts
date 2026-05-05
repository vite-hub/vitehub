import ui from "@nuxt/ui"
import vueUse from "@vueuse/nuxt"
import { defineNuxtConfig } from "nuxt/config"

const iframeContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "frame-ancestors http://localhost:* http://127.0.0.1:*",
  "img-src 'self' data:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join("; ")

export default defineNuxtConfig({
  modules: [ui, vueUse],
  css: ["~/assets/css/main.css"],
  ssr: false,
  compatibilityDate: "2026-05-05",
  devtools: {
    enabled: false,
  },
  app: {
    head: {
      title: "ViteHub Chat DevTools",
      htmlAttrs: {
        lang: "en",
      },
    },
  },
  icon: {
    provider: "server",
    serverBundle: {
      collections: ["lucide"],
    },
    clientBundle: {
      icons: ["lucide:arrow-up", "lucide:info", "lucide:loader-circle", "lucide:square", "lucide:trash-2"],
    },
  },
  vite: {
    resolve: {
      dedupe: ["vue", "@vue/runtime-core", "@vue/runtime-dom", "@vue/reactivity", "@vue/shared"],
    },
  },
  nitro: {
    preset: "cloudflare-module",
    routeRules: {
      "/": {
        redirect: "/chat",
      },
      "/chat": {
        headers: {
          "cache-control": "no-cache",
          "content-security-policy": iframeContentSecurityPolicy,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      },
      "/chat/**": {
        headers: {
          "cache-control": "no-cache",
          "content-security-policy": iframeContentSecurityPolicy,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      },
      "/_nuxt/**": {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        },
      },
    },
  },
})
