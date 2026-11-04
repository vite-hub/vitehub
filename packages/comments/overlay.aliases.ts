import { resolve } from "node:path"

export { standaloneUI } from "../ui/src/standalone/vite.ts"

const root = import.meta.dirname
const ui = resolve(root, "../ui")

/**
 * The overlay builds the comment parts from the `@vite-hub/ui` sources. `@vite-hub/ui` depends on this package, so this
 * package cannot depend on it. The parts read the client of this build, so threads and anchors are one module.
 */
export const overlayAliases = [
  { find: /^@vite-hub\/ui\/styles\.css\?inline$/, replacement: `${resolve(ui, "styles.css")}?inline` },
  { find: /^@vite-hub\/ui\/standalone\/(.+)$/, replacement: `${resolve(ui, "src/standalone")}/$1` },
  { find: /^@vite-hub\/ui\/comments$/, replacement: resolve(ui, "src/comments.ts") },
  { find: /^@vite-hub\/ui\/headless$/, replacement: resolve(ui, "src/headless.ts") },
  { find: /^@vite-hub\/comments\/client$/, replacement: resolve(root, "src/client.ts") },
]
