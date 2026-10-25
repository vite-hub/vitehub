import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { CommentsOverlayAssets } from "@vite-hub/comments/vite"

/** The folders that can hold the bundle: packaged `dist/comments-overlay`, or the build output next to the source. */
function candidates(): string[] {
  return [
    fileURLToPath(new URL("./comments-overlay", import.meta.url)),
    fileURLToPath(new URL("../../.vitehub/comments-overlay", import.meta.url)),
    fileURLToPath(new URL("../.vitehub/comments-overlay", import.meta.url)),
  ]
}

/**
 * The prebuilt loader and overlay. They are built with the package (`overlay.vite.config.ts`), and their file names
 * carry a hash of their content. Undefined where the bundle was not built, so the app simply has no overlay.
 */
export function commentsOverlayAssets(): CommentsOverlayAssets | undefined {
  for (const dir of candidates()) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir)
    const loader = files.find(file => /^loader\.[\w-]+\.js$/.test(file))
    const overlay = files.find(file => /^overlay\.[\w-]+\.js$/.test(file))
    if (loader && overlay) return { dir, loader, overlay }
  }
  return undefined
}
