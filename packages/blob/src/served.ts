// The served Blob route of the generated Blob config, readable without loading the Blob runtime. It has no
// dependencies, so browser code such as `contentHead()` may import it; there it stays empty.

/** Where `blob.serve` serves one Blob Store: its route and, optionally, a public origin. */
export interface ServedBlobRoute {
  route: string
  store: string
  publicBaseUrl?: string
}

let served: ServedBlobRoute | undefined

/** Set by the Blob runtime when it loads the generated Blob config. `undefined` when `blob.serve` is off. */
export function setServedBlobRoute(route: ServedBlobRoute | undefined): void {
  served = route ? { ...route } : undefined
}

/**
 * The URL that `blob.serve` serves a pathname at, such as `/api/_vitehub/blob/covers/a.png`, from the generated Blob
 * config. Undefined when the store is not served, or before the Blob runtime loaded its config, as in the browser.
 */
export function servedBlobUrl(pathname: string, store = "default"): string | undefined {
  if (!served || served.store !== store || !pathname) return undefined
  const base = (served.publicBaseUrl || "").replace(/\/+$/, "")
  const route = served.route.replace(/^\/+|\/+$/g, "")
  const path = pathname.split("/").map(segment => encodeURIComponent(segment)).join("/")
  return `${base}/${route ? `${route}/` : ""}${path}`
}
