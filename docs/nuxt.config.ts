import { defineNuxtConfig } from "nuxt/config";

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
        { rel: "icon", href: "/favicon.svg" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      ],
    },
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
});
