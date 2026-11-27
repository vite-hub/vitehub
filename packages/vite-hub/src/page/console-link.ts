// The link of the Console segment in the page tools pill. It has no DOM code, so tests run it in Node.
import { parseContentField } from "@vite-hub/content/client"
import { hostedConsoleUrl } from "@vite-hub/runtime"

const appBase = /^(?:\/(?!\.\.?(?:\/|$))[^/?#\\]+)*$/

/**
 * Where the segment script came from. A Console serves it, such as
 * `https://console.vitehub.dev/page/0.4.0/<hash>/page-tool.js?base=/portal`, with the app base in its `base` query. The
 * segment opens that Console, also when the page is on the Console itself. A `base` that is not an app base reads as `""`.
 */
export function consoleScriptSource(scriptUrl: string): { base: string, consoleOrigin: string } {
  const url = new URL(scriptUrl)
  const base = url.searchParams.get("base") ?? ""
  return { base: appBase.test(base) ? base : "", consoleOrigin: url.origin }
}

/**
 * The Console path of the Content document that a page shows, from the `data-content-field` values of its elements, such
 * as `/content/posts/hello`. A page that shows one document gets it. A page that shows several, such as a post in a layout
 * with a settings singleton, gets the one document with an id. Otherwise `/`, the project overview.
 */
export function consoleDocumentPath(fields: readonly string[]): string {
  const documents = new Map<string, { collection: string, id?: string }>()
  for (const value of fields) {
    const address = parseContentField(value)
    if (address) documents.set(`${address.collection}\0${address.id ?? ""}`, { collection: address.collection, id: address.id })
  }
  const all = [...documents.values()]
  const withId = all.filter(document => document.id !== undefined)
  const document = all.length === 1 ? all[0] : withId.length === 1 ? withId[0] : undefined
  if (!document) return "/"
  const segments = [document.collection, ...document.id?.split("/") ?? []]
  return `/content/${segments.map(encodeURIComponent).join("/")}`
}

/**
 * The Console URL that opens this app, or `undefined` when the page origin cannot be a Console project, such as `http:` on
 * a host that is not loopback. `origin` is the page origin, `base` the app base, `fields` the `data-content-field` values
 * of the page, and `consoleOrigin` the Console to open, the hosted Console by default.
 */
export function consolePageLink(origin: string, base: string, fields: readonly string[] = [], consoleOrigin?: string): string | undefined {
  try {
    return hostedConsoleUrl(`${origin}${base}`, consoleDocumentPath(fields), consoleOrigin)
  }
  catch {
    return undefined
  }
}
