import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { literalValue, unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, Identifier, Node } from "@babel/types"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const cmsModules = new Set(["vite-hub/cms", "@vite-hub/cms"])

const contentModules = new Set(["vite-hub/content", "@vite-hub/content"])

function contentBindings(program: File) {
  const presets = new Set<Identifier>()
  const namespaces = new Set<Identifier>()
  const definitions = new Set<Identifier>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    const fromCms = cmsModules.has(statement.source.value)
    const fromContent = contentModules.has(statement.source.value)
    if (!fromCms && !fromContent) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportDefaultSpecifier" && fromCms) presets.add(specifier.local)
      if (specifier.type === "ImportNamespaceSpecifier" && fromCms) namespaces.add(specifier.local)
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const imported = keyName(specifier.imported)
      if (fromCms && (imported === "cms" || imported === "default")) presets.add(specifier.local)
      if (fromContent && imported === "defineContent") definitions.add(specifier.local)
    }
  }
  return { presets, namespaces, definitions }
}

function resolvesTo(node: Node, bindings: Set<Identifier>, resolve: ReturnType<typeof bindingResolver>): boolean {
  if (node.type !== "Identifier") return false
  const binding = resolve(node)
  return binding !== undefined && bindings.has(binding)
}

function isCmsPreset(node: Node, bindings: ReturnType<typeof contentBindings>, resolve: ReturnType<typeof bindingResolver>): boolean {
  const value = unwrapExpression(node)
  if (value.type === "Identifier") return resolvesTo(value, bindings.presets, resolve)
  return value.type === "MemberExpression" && !value.computed && value.property.type === "Identifier"
    && (value.property.name === "cms" || value.property.name === "default")
    && resolvesTo(value.object, bindings.namespaces, resolve)
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
    const bindings = contentBindings(program)
    if (!bindings.definitions.size || (!bindings.presets.size && !bindings.namespaces.size)) continue
    const resolve = bindingResolver(program)
    const output = new MagicString(code)
    let changed = false
    walk(program, (node) => {
      if (node.type !== "CallExpression" || !resolvesTo(node.callee, bindings.definitions, resolve)) return
      const [argument] = node.arguments
      const definition = argument && unwrapExpression(argument)
      if (definition?.type !== "ObjectExpression") return
      for (const selection of definition.properties) {
        if (selection.type !== "ObjectProperty" || selection.computed || keyName(selection.key) !== "extends") continue
        const tuple = unwrapExpression(selection.value)
        if (tuple.type !== "ArrayExpression" || tuple.elements.length !== 2) continue
        const [preset, options] = tuple.elements
        if (!preset || !options || !isCmsPreset(preset, bindings, resolve)) continue
        const object = unwrapExpression(options)
        if (object.type !== "ObjectExpression") continue
        for (const property of object.properties) {
          if (property.type !== "ObjectProperty" || property.computed || keyName(property.key) !== "access") continue
          if (literalValue(property.value) === "roles") {
            output.overwrite(start(property), end(property), "roles: true")
            changed = true
          }
          else followUps.push({ file, line: line(property), message: "The cms preset option `access` was renamed. Replace `access: \"roles\"` with `roles: true` by hand." })
        }
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
