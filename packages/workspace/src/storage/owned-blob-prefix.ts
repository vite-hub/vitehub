import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"

import { workspaceError } from "../core/errors.ts"

/**
 * Returns `_vitehub/<root>`, or `_vitehub/<root>/<prefix>` for a custom prefix.
 * ViteHub owns every Workspace Blob object, so a custom prefix only nests below the owned root.
 */
export function ownedBlobPrefix(root: string, prefix: string | undefined, label: string): string {
  if (prefix !== undefined && !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw workspaceError(`[vitehub] ${label} Blob prefix must contain only letters, numbers, underscores, dashes, and single slashes.`)
  const owned = `${vitehubOwnedPrefix}${root}`
  return prefix === undefined ? owned : `${owned}/${prefix}`
}
