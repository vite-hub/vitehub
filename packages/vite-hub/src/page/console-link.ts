// The link of the Console segment in the page tools pill. It has no DOM code, so tests run it in Node.
import { parseContentField } from "@vite-hub/content/client"
import { hostedConsoleUrl } from "@vite-hub/runtime"

/** The marker in the URL of the segment script. The part before it is the app base. */
const scriptMarker = "/_vitehub/console/assets/"

/** The app base of the segment script URL, such as `/portal` for `/portal/_vitehub/console/assets/page-tool.js`. */
export function consolePageBase(scriptPath: string): string {
  const index = scriptPath.lastIndexOf(scriptMarker)
  return index > 0 ? scriptPath.slice(0, index) : ""
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
 * The hosted Console URL that opens this app, or `undefined` when the page origin cannot be a Console project, such as
 * `http:` on a host that is not loopback. `origin` is the page origin, `base` the app base, and `fields` the
 * `data-content-field` values of the page.
 */
export function consolePageLink(origin: string, base: string, fields: readonly string[] = []): string | undefined {
  try {
    return hostedConsoleUrl(`${origin}${base}`, consoleDocumentPath(fields))
  }
  catch {
    return undefined
  }
}
