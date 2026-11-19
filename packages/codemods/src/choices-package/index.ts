import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { glob } from "tinyglobby"

import type { Codemod, CodemodContext, CodemodResult, FileEdit } from "../types.ts"

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}", "**/package.json"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "peerDependenciesMeta"]

/** A quoted `@vite-hub/decisions` or `vite-hub/decisions` module name, with its subpath. */
const modulePattern = /(["'`])(@vite-hub\/|vite-hub\/)decisions((?:\/[\w./-]*)?)\1/g
/** The CLI command in a package script. */
const commandPattern = /\bvitehub decisions\b/g

/** Renames the dependency and the CLI command in a manifest, and keeps its key order and indentation. */
function migrateManifest(code: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(code)
  }
  catch {
    return code
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return code
  let changed = false
  const renamed = Object.fromEntries(Object.entries(manifest).map(([section, value]) => {
    if (dependencySections.includes(section) && typeof value === "object" && value !== null && Object.hasOwn(value, "@vite-hub/decisions")) {
      changed = true
      const entries = Object.entries(value).map(([name, range]) => [name === "@vite-hub/decisions" ? "@vite-hub/choices" : name, range] as const)
      return [section, Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))]
    }
    if (section === "scripts" && typeof value === "object" && value !== null) {
      return [section, Object.fromEntries(Object.entries(value).map(([name, script]) => {
        if (typeof script !== "string" || !script.includes("vitehub decisions")) return [name, script]
        changed = true
        return [name, script.replace(commandPattern, "vitehub choices")]
      }))]
    }
    return [section, value]
  }))
  if (!changed) return code
  const indent = /^[ \t]+/m.exec(code)?.[0] ?? "  "
  return `${JSON.stringify(renamed, null, indent)}${code.endsWith("\n") ? "\n" : ""}`
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("decisions")) continue
    const after = file.endsWith("package.json") ? migrateManifest(code) : code.replace(modulePattern, "$1$2choices$3$1")
    if (after !== code) edits.push({ path: file, before: code, after })
  }
  const manifests = edits.some(edit => edit.path.endsWith("package.json"))
  return {
    summary: edits.length ? `renamed Decisions to Choices in ${edits.length} file(s)` : "found no @vite-hub/decisions import",
    edits,
    followUps: [],
    notes: [],
    nextSteps: manifests ? ["Run your package manager's install, so @vite-hub/choices replaces @vite-hub/decisions."] : [],
  }
}

export const choicesPackage: Codemod = {
  name: "choices-package",
  description: "Rename `@vite-hub/decisions` to `@vite-hub/choices`, `vite-hub/decisions` to `vite-hub/choices`, and `vitehub decisions` to `vitehub choices`",
  usage: "[dir]",
  async detect({ cwd }) {
    const [edit] = (await migrate({ cwd })).edits
    return edit ? { reason: `${edit.path} uses @vite-hub/decisions` } : undefined
  },
  run: migrate,
}
