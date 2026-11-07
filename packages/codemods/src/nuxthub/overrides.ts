import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { FollowUp } from "../types.ts"

const scopeFix = "vite-hub/nuxt imports h3 2, so Nuxt cannot load it while every package gets h3 1 (ERR_PACKAGE_PATH_NOT_EXPORTED). Scope the override to the package that needs h3 1, for example `'nuxt-csurf>h3': 1.15.11`."

/** An h3 1 range or version, such as `1.15.11`, `^1.15.0`, or `~1`. */
const h3One = /^[\^~]?1(?:\.|$)/

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Finds overrides that pin h3 1 for every package, in pnpm-workspace.yaml and in package.json. */
export async function findGlobalH3Overrides(cwd: string): Promise<FollowUp[]> {
  const followUps: FollowUp[] = []
  const workspaceFile = join(cwd, "pnpm-workspace.yaml")
  if (existsSync(workspaceFile)) {
    const code = await readFile(workspaceFile, "utf8")
    const block = /^overrides:[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$)|[ \t]*\r?\n)*)/m.exec(code)
    if (block?.[1]) {
      const offset = block.index + block[0].length - block[1].length
      for (const entry of block[1].matchAll(/^[ \t]+(['"]?)h3\1[ \t]*:[ \t]*(['"]?)([^'"\s#]+)\2/gm)) {
        if (entry[3] && h3One.test(entry[3])) {
          followUps.push({ file: "pnpm-workspace.yaml", line: lineAt(code, offset + entry.index), message: `pnpm-workspace.yaml overrides h3 to ${entry[3]} for every package. ${scopeFix}` })
        }
      }
    }
  }
  const packageFile = join(cwd, "package.json")
  if (existsSync(packageFile)) {
    const code = await readFile(packageFile, "utf8")
    const manifest: unknown = JSON.parse(code)
    if (!isRecord(manifest)) return followUps
    const fields: Array<[string, unknown]> = [["pnpm.overrides", isRecord(manifest.pnpm) ? manifest.pnpm.overrides : undefined], ["overrides", manifest.overrides], ["resolutions", manifest.resolutions]]
    for (const [field, value] of fields) {
      const version = isRecord(value) ? value.h3 : undefined
      if (typeof version !== "string" || !h3One.test(version)) continue
      const index = code.indexOf("\"h3\"")
      followUps.push({ file: "package.json", ...(index >= 0 ? { line: lineAt(code, index) } : {}), message: `package.json ${field} sets h3 to ${version} for every package. ${scopeFix}` })
    }
  }
  return followUps
}
