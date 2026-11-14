import { viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-shared"

import { projectAppUrl, resolveProjectUrl } from "./project"

// An app path, as Comments stores the page of a thread: one leading slash, no whitespace, `\`, `?`, or `#`.
const pagePath = /^\/(?![/\\])[^\s\\?#]*$/

/**
 * The address of the app that opens a page with Comments in comment mode: `?vitehub=comments`. `page` is the app path
 * of a thread, such as `/pricing`. Without it, the app's home page opens. The page asks the app who the person is, so
 * a person without Comments access gets the app's sign-in, as on any page. Undefined for a page that is not an app path.
 * A thread has its own link, `?comment=<n>`, which the Comments section builds.
 */
export function commentOnSiteUrl(page?: string): string | undefined {
  if (page !== undefined && !pagePath.test(page)) return undefined
  return `${page === undefined ? projectAppUrl("/") : resolveProjectUrl(page)}?${viteHubPageToolsQuery}=comments`
}
