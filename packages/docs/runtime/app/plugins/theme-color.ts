import { defineNuxtPlugin, nextTick, ref, useHead, watch } from "#imports"
import { ownsApp } from "#docs/shell"

// The browser bar matches the page canvas: the `--ui-bg` of the design system, read from the page, so the theme stays
// the only place that names the color. It follows the mode that the reader picks. A plugin, and not `app.vue`, so the
// error page has it too. An app with its own `app.vue` keeps its browser bar color. Prerendered HTML has no value, and
// browsers use their own bar color until the app starts.
export default defineNuxtPlugin((nuxtApp) => {
  if (!ownsApp || import.meta.server) return
  const color = ref<string>()
  const read = () => {
    color.value = getComputedStyle(document.documentElement).backgroundColor || undefined
  }
  nuxtApp.hook("app:mounted", read)
  // The color mode module sets the class on `<html>` after the value changes, so read after that render.
  watch(() => nuxtApp.$colorMode?.value, () => nextTick(() => requestAnimationFrame(read)))
  useHead({ meta: [{ name: "theme-color", content: color }] })
})
