import { defineNuxtModule } from "@nuxt/kit"

import { docsAppPath } from "./navigation.ts"
import { docsRedirects, type DocsRouteRule } from "./redirects.ts"

interface LinkCheckerNuxtOptions {
  app: { baseURL: string }
  routeRules?: Record<string, DocsRouteRule | undefined>
  nitro: { routeRules?: Record<string, DocsRouteRule | undefined> }
  linkChecker?: { excludeLinks?: Array<string | RegExp> }
}

/**
 * The link checker reads its options once, when Nuxt installs it, and reports every link to a redirect. The docs module
 * installs this module just before it, after the app's modules have added their route rules, so a link to a redirect
 * route rule passes. The docs module checks where each redirect goes instead.
 */
const linkCheckerRedirects: { (inlineOptions: Record<string, never>, nuxt: never): unknown } = defineNuxtModule({
  meta: { name: "@vite-hub/docs/link-checker-redirects" },
  setup(_options, nuxt) {
    const options: LinkCheckerNuxtOptions = nuxt.options
    const linkChecker = (options.linkChecker ??= {})
    // Direct redirects to another site keep the link checker's own inspections.
    const redirects = docsRedirects({ ...options.nitro.routeRules, ...options.routeRules }).filter(redirect => redirect.to.startsWith("/") && !redirect.to.startsWith("//"))
    linkChecker.excludeLinks = [...linkChecker.excludeLinks ?? [], ...redirects.map(redirect => docsAppPath(redirect.from, options.app.baseURL))]
  },
})

export default linkCheckerRedirects
