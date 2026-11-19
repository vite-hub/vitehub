import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File } from "@babel/types"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const cmsModules = new Set(["vite-hub/cms", "@vite-hub/cms"])

/** The local names of the `cms` preset that the file imports. */
function cmsBindings(program: File): Set<string> {
  const names = new Set<string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !cmsModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier") names.add(specifier.local.name)
      if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && keyName(specifier.imported) === "cms") names.add(specifier.local.name)
    }
  }
  return names
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("cms") || !/\baccess\b/.test(code)) continue
    let program: File
    try {
      program = parseProgram(code, { jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) })
    }
    catch {
      continue
    }
    const presets = cmsBindings(program)
    if (!presets.size) continue
    const output = new MagicString(code)
    let changed = false
    walk(program, (node) => {
      // `extends: [cms, { ... }]` selects the preset with options.
      if (node.type !== "ArrayExpression" || node.elements.length !== 2) return
      const [preset, options] = node.elements
      if (preset?.type !== "Identifier" || !presets.has(preset.name) || !options) return
      const object = unwrapExpression(options)
      if (object.type !== "ObjectExpression") return
      for (const property of object.properties) {
        if (property.type !== "ObjectProperty" || property.computed || keyName(property.key) !== "access") continue
        const value = unwrapExpression(property.value)
        if (value.type === "StringLiteral" && value.value === "roles") {
          output.overwrite(start(property), end(property), "roles: true")
          changed = true
        }
        else followUps.push({ file, line: line(property), message: "The cms preset option `access` was renamed. Replace `access: \"roles\"` with `roles: true` by hand." })
      }
    })
    if (changed) edits.push({ path: file, before: code, after: output.toString() })
  }
  return {
    summary: edits.length ? `renamed the cms preset option access: "roles" to roles: true in ${edits.length} file(s)` : "found no cms preset access option",
    edits,
    followUps,
    notes: [],
    nextSteps: [],
  }
}

export const cmsRoles: Codemod = {
  name: "cms-roles",
  description: "Rename the cms preset option `access: \"roles\"` to `roles: true`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} sets the cms preset option \`access\`` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} sets the cms preset option \`access\`` } : undefined
  },
  run: migrate,
}
