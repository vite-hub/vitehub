import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

let installed: string | undefined

/**
 * The version of the installed `vite-hub` package, read from its `package.json`. The pkg.pr.new workflow sets a preview
 * version after the build, so a version that the build put in the code would name the npm release instead.
 */
export function readViteHubVersion(): string {
  installed ??= (JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("vite-hub/package.json")), "utf8")) as { version: string }).version
  return installed
}
