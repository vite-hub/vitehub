import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, sep } from "node:path"

/** The file in the packaged Console runtime that holds its digest. The package build writes it. */
export const consoleRuntimeDigestFile = "digest.txt"

/**
 * A digest of the Console runtime, client, and assets in `root`.
 * The Console client build puts a content hash in the name of each file in `public/console`, so the digest reads only
 * those names, not the 20 MB client.
 */
export function digestConsoleRuntime(root: string): string {
  const hash = createHash("sha256")
  const publicRoot = join(root, "public/console")
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && file !== join(root, consoleRuntimeDigestFile)) files.push(file)
    }
  }
  if (existsSync(root)) visit(root)
  for (const file of files.sort()) {
    hash.update(file.slice(root.length)).update("\0")
    if (!file.startsWith(publicRoot + sep)) hash.update(readFileSync(file)).update("\0")
  }
  return hash.digest("hex")
}
