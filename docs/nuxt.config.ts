import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  extends: ["docus"],
  modules: ["./modules/vitehub-docs"],
  site: {
    name: "ViteHub",
    url: "https://vitehub.dev",
  },
  llms: {
    domain: "https://vitehub.dev",
    title: "ViteHub",
    description: "Server primitives for Vite.",
  },
  css: ["~/assets/main.css"],
  devtools: {
    enabled: false,
  },
  nitro: {
    prerender: {
      crawlLinks: true,
    },
  },
  experimental: {
    payloadExtraction: false,
    defaults: {
      nuxtLink: {
        trailingSlash: "append",
      },
    },
  },
} as any);
