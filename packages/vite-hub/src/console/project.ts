import { readFileSync } from "node:fs"
import { basename, join } from "node:path"

export function resolveConsoleProjectNameFromRoot(projectRoot: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { name?: unknown }
    if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name.trim()
  }
  catch {}
  return basename(projectRoot)
}
