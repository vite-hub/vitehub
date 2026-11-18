import file, { names } from "#docs/comark-css"
import { defineNuxtPlugin, useHead, useRuntimeConfig } from "#imports"

// The comark-ui stylesheet that every page needs, the error page too. It is a public asset, so its URL follows Nuxt's
// rule for those: below `app.cdnURL` when set, else below `app.baseURL`. Both are read at runtime, since
// `NUXT_APP_BASE_URL` and `NUXT_APP_CDN_URL` can change them after the build.
// The link goes after the app's CSS, where the components add their styles, since some of their unlayered rules tie
// with the app's and must still win. Its `data-comark-<name>` attributes tell each component its styles are on the page.
export default defineNuxtPlugin(() => {
  const { baseURL, cdnURL } = useRuntimeConfig().app
  const base = (cdnURL || baseURL).replace(/\/*$/, "/")
  const marks = Object.fromEntries(names.map(name => [`data-comark-${name}`, ""]))
  useHead({ link: [{ rel: "stylesheet", href: `${base}_docs/${file}`, tagPriority: "low", ...marks }] })
})
