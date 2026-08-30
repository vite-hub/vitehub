import { readFileSync } from "node:fs"
import { basename, join } from "node:path"

import * as v from "valibot"

const projectManifestSchema = v.object({ name: v.optional(v.string()) })

export function resolveConsoleProjectNameFromRoot(projectRoot: string): string {
  try {
    const source: unknown = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))
    const manifest = v.safeParse(projectManifestSchema, source)
    if (manifest.success && manifest.output.name?.trim()) return manifest.output.name.trim()
  }
  catch {}
  return basename(projectRoot)
}
