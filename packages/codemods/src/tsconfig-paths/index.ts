import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { parseExpression } from "@babel/parser"
import { findProperty, keyName, line, listItemRemoval } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import type { Node, ObjectExpression, ObjectProperty } from "@babel/types"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const tsconfigPatterns = ["**/tsconfig.json", "**/tsconfig.*.json"]
const ignored = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

/** Folders that ViteHub and Nuxt write. A `#vitehub/*` path into them maps an alias that ViteHub now types and resolves itself. */
const generatedFolder = /(?:^|\/)\.(?:vitehub|nuxt)\//

interface PathsPlan {
  edit?: FileEdit
  followUps: FollowUp[]
  removed: string[]
}

function objectValue(node: Node | undefined): ObjectExpression | undefined {
  return node?.type === "ObjectExpression" ? node : undefined
}

function targets(property: ObjectProperty): string[] | undefined {
  if (property.value.type !== "ArrayExpression") return undefined
  const values: string[] = []
  for (const element of property.value.elements) {
    if (element?.type !== "StringLiteral") return undefined
    values.push(element.value)
  }
  return values
}

/** Plans the removal of the `#vitehub/*` entries of one tsconfig file's `compilerOptions.paths`. */
function planPaths(file: string, code: string): PathsPlan {
  const plan: PathsPlan = { followUps: [], removed: [] }
  if (!code.includes("#vitehub/")) return plan
  let root: ObjectExpression | undefined
  try {
    // tsconfig files are JSON with comments and trailing commas, which a JavaScript expression accepts too.
    root = objectValue(parseExpression(code))
  }
  catch {
    plan.followUps.push({ file, message: "The codemod could not parse this tsconfig. Remove the `#vitehub/*` entries of `compilerOptions.paths` by hand: ViteHub types and resolves them itself." })
    return plan
  }
  const compilerOptions = objectValue(root && findProperty(root, "compilerOptions")?.value)
  const pathsProperty = compilerOptions && findProperty(compilerOptions, "paths")
  const paths = objectValue(pathsProperty?.value)
  if (!pathsProperty || !paths) return plan
  const output = new MagicString(code)
  const entries = paths.properties.filter((item): item is ObjectProperty => item.type === "ObjectProperty")
  for (const entry of entries) {
    const alias = keyName(entry.key, entry.computed)
    if (!alias?.startsWith("#vitehub/")) continue
    const values = targets(entry)
    if (values?.length && values.every(value => generatedFolder.test(value.replace(/^\.\//, "")))) {
      const [from, to] = listItemRemoval(code, entry)
      output.remove(from, to)
      plan.removed.push(alias)
    }
    else {
      plan.followUps.push({ file, line: line(entry), message: `\`${alias}\` maps a ViteHub alias to your own file. ViteHub types and resolves \`#vitehub/*\` itself. Remove this entry unless it points at a test stub on purpose.` })
    }
  }
  if (!plan.removed.length) return plan
  // An empty `paths` would replace the paths of an extended tsconfig, such as `.nuxt/tsconfig.json`, with nothing.
  if (plan.removed.length === paths.properties.length) {
    const [from, to] = listItemRemoval(code, pathsProperty)
    return { ...plan, edit: { path: file, before: code, after: `${code.slice(0, from)}${code.slice(to)}` } }
  }
  return { ...plan, edit: { path: file, before: code, after: output.toString() } }
}

async function tsconfigFiles(cwd: string): Promise<string[]> {
  return (await glob(tsconfigPatterns, { cwd, ignore: ignored, dot: false })).sort()
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const notes: string[] = []
  for (const file of await tsconfigFiles(cwd)) {
    const plan = planPaths(file, await readFile(join(cwd, file), "utf8"))
    if (plan.edit) edits.push(plan.edit)
    followUps.push(...plan.followUps)
    if (plan.removed.length) notes.push(`${file}: removed ${plan.removed.map(alias => `\`${alias}\``).join(", ")} from compilerOptions.paths. ViteHub generates their types in .vitehub/types/.`)
  }
  return {
    summary: edits.length ? `removed stale #vitehub/* paths from ${edits.length} tsconfig file(s)` : "found no #vitehub/* path to remove",
    edits,
    followUps,
    notes,
    nextSteps: edits.length ? ["Run `vitehub types prepare` or start the dev server, so ViteHub writes the types of the #vitehub/* aliases."] : [],
  }
}

export const tsconfigPaths: Codemod = {
  name: "tsconfig-paths",
  description: "Remove the #vitehub/* entries of tsconfig paths that point into generated folders, because ViteHub types those aliases itself",
  usage: "[dir]",
  async detect({ cwd }) {
    for (const file of await tsconfigFiles(cwd)) {
      const plan = planPaths(file, await readFile(join(cwd, file), "utf8"))
      if (plan.edit || plan.followUps.length) return { reason: `${file} maps #vitehub/* in compilerOptions.paths` }
    }
    return undefined
  },
  run: migrate,
}
