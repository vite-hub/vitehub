import { defineNuxtPlugin, useHead } from "#imports"

const canvas = { light: "#ffffff", dark: "#09090b" }

// The browser bar matches the page canvas. Prerendered HTML has one color per system mode. In the browser, both follow
// the mode that the reader picked. A plugin, and not `app.vue`, so the error page has it too.
export default defineNuxtPlugin((nuxtApp) => {
  const color = (scheme: "light" | "dark") => () => {
    const mode = nuxtApp.$colorMode
    return !mode || mode.unknown ? canvas[scheme] : canvas[mode.value === "dark" ? "dark" : "light"]
  }
  useHead({
    meta: [
      { name: "theme-color", media: "(prefers-color-scheme: light)", content: color("light") },
      { name: "theme-color", media: "(prefers-color-scheme: dark)", content: color("dark") },
    ],
  })
})
