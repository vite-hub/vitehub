import { appPathname, readLoaderOptions, runLoader, trackNavigation } from "./loader-core.ts"
import type { OverlayModule } from "./loader-core.ts"

// The loader URL is `<base>_vitehub/comments/loader.<hash>.js?f=<overlay file>&o=<options>`: it finds the app base, the
// RPC, and the overlay from its own URL, so the page needs no configuration beyond the tag.
const self = new URL(import.meta.url)
const folder = new URL("./", self)
const base = new URL("../../", self).pathname
const file = new URLSearchParams(self.search).get("f") ?? ""

// Only the overlay file that the tag names, in the same folder.
if (/^overlay\.[\w-]+\.js$/.test(file)) {
  // A module script has no `document.currentScript`: find the tag by its URL. Its nonce goes to the overlay's own styles.
  const tag = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].find(script => script.src === self.href)
  void runLoader(readLoaderOptions(self.search), {
    base,
    fetch: (input, init) => globalThis.fetch(input, init),
    load: url => import(/* @vite-ignore */ url) as Promise<OverlayModule>,
    overlayUrl: new URL(file, folder).href,
    path: () => appPathname(location.pathname, base),
    subscribe: trackNavigation,
    ...(tag?.nonce ? { nonce: tag.nonce } : {}),
  })
}
