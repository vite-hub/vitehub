import { defineNuxtPlugin, useHead } from "#imports"
import { ownsApp } from "#docs/shell"

const canvas = { light: "#ffffff", dark: "#09090b" }

// The browser bar matches the page canvas. Prerendered HTML has one color per system mode. In the browser, both follow
// the mode that the reader picked. A plugin, and not `app.vue`, so the error page has it too. An app with its own
// `app.vue` keeps its own browser bar color.
export default defineNuxtPlugin((nuxtApp) => {
  if (!ownsApp) return
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
