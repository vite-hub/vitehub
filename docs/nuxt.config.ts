import { defineNuxtConfig } from "nuxt/config";

const nitroPreset = process.env.NITRO_PRESET || (process.env.VERCEL ? "vercel" : undefined);

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
  app: {
    head: {
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    },
  },
  css: ["~/assets/main.css"],
  devtools: {
    enabled: false,
  },
  nitro: {
    preset: nitroPreset,
    prerender: {
      crawlLinks: false,
      routes: [],
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
