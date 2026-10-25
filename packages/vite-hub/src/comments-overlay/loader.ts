import { readLoaderOptions, runLoader } from "./loader-core.ts"
import type { OverlayModule } from "./loader-core.ts"

// The loader URL is `<base>_vitehub/comments/loader.js?v=<version>&o=<options>`: it finds the app base, the RPC, and the
// overlay from its own URL, so the page needs no configuration beyond the tag.
const self = new URL(import.meta.url)
const folder = new URL("./", self)
const base = new URL("../../", self).pathname

void runLoader(readLoaderOptions(self.search), {
  base,
  fetch: (input, init) => globalThis.fetch(input, init),
  load: url => import(/* @vite-ignore */ url) as Promise<OverlayModule>,
  overlayUrl: `${folder.href}overlay.js?v=${new URLSearchParams(self.search).get("v") ?? ""}`,
  pathname: location.pathname.startsWith(base) ? `/${location.pathname.slice(base.length)}` : location.pathname,
})
