import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { CommentsOverlayAssets } from "@vite-hub/comments/vite"

/**
 * The prebuilt loader and overlay. They are built with the package (`overlay.vite.config.ts`) and packaged under
 * `dist/comments-overlay`; from source, the build output sits in `.vitehub/comments-overlay`. Undefined where the
 * bundle was not built, so the app simply has no overlay.
 */
export function commentsOverlayAssets(): CommentsOverlayAssets | undefined {
  const dir = [
    fileURLToPath(new URL("./comments-overlay", import.meta.url)),
    fileURLToPath(new URL("../../.vitehub/comments-overlay", import.meta.url)),
    fileURLToPath(new URL("../.vitehub/comments-overlay", import.meta.url)),
  ].find(candidate => existsSync(join(candidate, "loader.js")) && existsSync(join(candidate, "overlay.js")))
  if (!dir) return undefined
  const hash = createHash("sha256")
  for (const file of ["loader.js", "overlay.js"]) hash.update(readFileSync(join(dir, file)))
  return { dir, version: hash.digest("hex").slice(0, 12) }
}
