import { readFileSync } from "node:fs"
import { basename, join } from "node:path"

import * as v from "valibot"

const projectManifestSchema = v.object({ name: v.optional(v.string()) })

/** The name that `project.get` reports: the `name` option of `vitehub()`, else the `package.json` name, else the folder. */
export function resolveConsoleProjectName(projectRoot: string, name?: string): string {
  if (name?.trim()) return name.trim()
  try {
    const source: unknown = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"))
    const manifest = v.safeParse(projectManifestSchema, source)
    if (manifest.success && manifest.output.name?.trim()) return manifest.output.name.trim()
  }
  catch {}
  return basename(projectRoot)
}
