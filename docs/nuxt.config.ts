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
      link: [{ rel: "icon", href: "/favicon.svg" }],
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
