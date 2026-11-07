import file from "#docs/comark-css"
import { defineNuxtPlugin, useHead, useRuntimeConfig } from "#imports"

// The comark-ui stylesheet that every page needs, the error page too. Nitro serves it below the `app.baseURL` of the
// running server, which `NUXT_APP_BASE_URL` can change after the build, so the link reads the base at runtime.
export default defineNuxtPlugin(() => {
  const base = useRuntimeConfig().app.baseURL.replace(/\/*$/, "/")
  useHead({ link: [{ rel: "stylesheet", href: `${base}_docs/${file}` }] })
})
