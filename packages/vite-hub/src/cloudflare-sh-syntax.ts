import type { Plugin } from "vite"

/**
 * Resolves sh-syntax, the parser of `@vite-hub/shell`, to its browser build in a Cloudflare production build.
 *
 * sh-syntax maps that build only to the `browser` condition. Workers resolve `workerd`, so they get the Node build,
 * which reads `main.wasm` from disk while the Worker loads. The browser build lets `@vite-hub/shell` import the WASM
 * file as a module instead.
 */
export function cloudflareShSyntaxPlugin(): Plugin {
  return {
    name: "vite-hub/cloudflare-sh-syntax",
    apply: "build",
    enforce: "pre",
    resolveId: {
      filter: { id: /^sh-syntax$/ },
      async handler(id, importer, options) {
        // Development runs on Node, which reads main.wasm from disk.
        if (id !== "sh-syntax" || this.meta.watchMode) return
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true })
        if (!resolved) return
        return { ...resolved, id: resolved.id.replace(/lib[\\/]index\.js$/, "lib/browser.js") }
      },
    },
  }
}
