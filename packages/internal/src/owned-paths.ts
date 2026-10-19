/** Every Blob path that ViteHub writes for itself starts with this prefix. */
export const vitehubOwnedPrefix = "_vitehub/"

/**
 * Returns true when ViteHub owns the Blob pathname. Listing UIs hide these
 * paths, and user actions must not move or delete them.
 */
export function isVitehubOwnedPath(pathname: string): boolean {
  const parts: string[] = []
  for (const part of pathname.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  return parts[0]?.toLowerCase() === vitehubOwnedPrefix.slice(0, -1)
}
