import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, Identifier, ObjectExpression } from "@babel/types"
import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]

/** The script of a file, or of each script block of a Vue file, with its offset in the file. */
function scripts(file: string, code: string): Array<{ code: string, offset: number, lineOffset: number, typescript: boolean, jsx: boolean }> {
  if (!file.endsWith(".vue")) return [{ code, offset: 0, lineOffset: 0, typescript: !/\.(?:c|m)?jsx?$/.test(file), jsx: /\.[jt]sx$/.test(file) }]
  const { descriptor } = parseSfc(code, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{ code: block.content, offset: block.loc.start.offset, lineOffset: block.loc.start.line - 1, typescript: lang === "ts" || lang === "tsx", jsx: lang === "tsx" || lang === "jsx" }]
  })
}

function object(value: Node | undefined): ObjectExpression | undefined {
  const node = value && unwrapExpression(value)
  return node?.type === "ObjectExpression" ? node : undefined
}

function objectOption(options: ObjectExpression | undefined, name: string): ObjectExpression | undefined {
  const property = options?.properties.findLast(item => item.type === "SpreadElement" || keyName(item.key, item.computed) === undefined || keyName(item.key, item.computed) === name)
  return property?.type === "ObjectProperty" && keyName(property.key, property.computed) === name ? object(property.value) : undefined
}

function workspaceBindings(program: File) {
  const bindings = new Map<Identifier, "definition" | "integration">()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const name = keyName(specifier.imported)
      const module = statement.source.value
      if (name === "defineWorkspace" && (module === "vite-hub/workspace" || module === "@vite-hub/workspace")) bindings.set(specifier.local, "definition")
      if (name === "vitehub" && module === "vite-hub") bindings.set(specifier.local, "integration")
    }
  }
  return bindings
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("repository") || !code.includes("github")) continue
    const output = new MagicString(code)
    for (const block of scripts(file, code)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch {
        continue
      }
      const bindings = workspaceBindings(program)
      if (!bindings.size) continue
      const resolve = bindingResolver(program)
      walk(program, (node) => {
        if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return
        const binding = resolve(node.callee)
        const kind = binding && bindings.get(binding)
        if (!kind) return
        const options = object(node.arguments[0])
        const store = objectOption(kind === "integration" ? objectOption(options, "workspace") : options, "store")
        if (!store) return
        const driver = store.properties.findLast(item => item.type !== "SpreadElement" && keyName(item.key, item.computed) === "driver")
        const driverValue = driver?.type === "ObjectProperty" ? unwrapExpression(driver.value) : undefined
        if (driverValue?.type !== "StringLiteral" || driverValue.value !== "github") return
        const repository = store.properties.find(item => item.type !== "SpreadElement" && keyName(item.key, item.computed) === "repository")
        if (!repository) return
        if (repository.type !== "ObjectProperty" || store.properties.some(item =>
          item.type === "SpreadElement" || item.computed || keyName(item.key) === "repo" || (item !== repository && keyName(item.key) === "repository"))) {
          followUps.push({ file, line: block.lineOffset + line(repository), message: "Move the previously effective repository to `repo`, then remove `repository`. The old Store used a usable `repository` value before falling back to `repo`. Check both keys, spreads, and computed properties before you edit." })
          return
        }
        const key = repository.key
        const quote = block.code[start(key)]
        const text = repository.shorthand ? "repo: repository" : quote === "'" || quote === '"' ? `${quote}repo${quote}` : "repo"
        output.overwrite(block.offset + start(key), block.offset + end(key), text)
      })
    }
    if (output.hasChanged()) edits.push({ path: file, before: code, after: output.toString() })
  }
  return {
    summary: edits.length ? `renamed the GitHub Workspace Store option repository to repo in ${edits.length} file(s)` : "found no GitHub Workspace Store that sets repository",
    edits,
    followUps,
    notes: [],
    nextSteps: [],
  }
}

export const workspaceRepo: Codemod = {
  name: "workspace-repo",
  description: "Rename the GitHub Workspace Store option `repository` to `repo`",
  usage: "[dir]",
  async detect({ cwd }) {
    const result = await migrate({ cwd })
    const [edit] = result.edits
    if (edit) return { reason: `${edit.path} sets \`repository\` on a GitHub Workspace Store` }
    const [followUp] = result.followUps
    return followUp ? { reason: `${followUp.file} sets \`repository\` on a GitHub Workspace Store` } : undefined
  },
  run: migrate,
}
