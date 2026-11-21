import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { bindingResolver } from "../shared/binding-resolver.ts"
import { moduleSource } from "../shared/module-source.ts"

import type { Node } from "@vite-hub/internal/ast"
import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"

const sourcePatterns = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}", "**/package.json"]
const ignoredPatterns = ["**/node_modules/**", "**/.nuxt/**", "**/.output/**", "**/.data/**", "**/.vitehub/**", "**/dist/**", "**/coverage/**"]
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "peerDependenciesMeta"]

const oldPackage = "@vite-hub/decisions"
const newPackage = "@vite-hub/choices"
const modulePattern = /^(@vite-hub\/|vite-hub\/)decisions(?=(?:\/[\w./-]+)?$)/
const commandPattern = /^(\s*(?:(?:pnpm(?:[ \t]+exec)?|npm[ \t]+exec[ \t]+--|npx|yarn)[ \t]+)?vitehub[ \t]+)decisions(?=[ \t\r\n;|&<>]|$)/
const cliExports = new Map([
  ["createDecisionsCliNamespace", "createChoicesCliNamespace"],
  ["listDecisions", "listChoices"],
])

function migrateManifest(file: string, code: string, followUps: FollowUp[], changedDependencies: Set<string>): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(code)
  }
  catch {
    return code
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return code
  const sections = Object.entries(manifest)
  const peers: unknown = sections.find(([section]) => section === "peerDependencies")?.[1]
  const hasChoicesPeer = typeof peers === "object" && peers !== null && Object.hasOwn(peers, newPackage)
  let changed = false
  const renamed = Object.fromEntries(sections.map(([section, value]) => {
    if (dependencySections.includes(section) && typeof value === "object" && value !== null && Object.hasOwn(value, oldPackage)) {
      const entries = new Map(Object.entries(value))
      if (section === "peerDependenciesMeta" && !hasChoicesPeer) {
        followUps.push({ file, message: `Move ${oldPackage} metadata to ${newPackage} in peerDependenciesMeta when you update the peer dependency.` })
        return [section, value]
      }
      if (section !== "peerDependenciesMeta" && !entries.has(newPackage)) {
        followUps.push({ file, message: `Replace ${oldPackage} (${JSON.stringify(entries.get(oldPackage))}) in ${section} with ${newPackage} at a version compatible with your ViteHub release before installing.` })
        return [section, value]
      }
      if (!entries.has(newPackage)) entries.set(newPackage, entries.get(oldPackage))
      entries.delete(oldPackage)
      changedDependencies.add(file)
      changed = true
      return [section, Object.fromEntries(entries)]
    }
    if (section === "scripts" && typeof value === "object" && value !== null) {
      return [section, Object.fromEntries(Object.entries(value).map(([name, script]) => {
        if (typeof script !== "string") return [name, script]
        const updated = script.replace(commandPattern, "$1choices")
        if (/\bvitehub[ \t]+decisions\b/.test(updated)) {
          followUps.push({ file, message: `Check script ${JSON.stringify(name)} and change any remaining vitehub decisions command to vitehub choices.` })
        }
        if (updated !== script) changed = true
        return [name, updated]
      }))]
    }
    return [section, value]
  }))
  if (!changed) return code
  const indent = /^[ \t]+/m.exec(code)?.[0] ?? "  "
  return `${JSON.stringify(renamed, null, indent)}${code.endsWith("\n") ? "\n" : ""}`
}

function scriptBlocks(file: string, code: string) {
  if (!file.endsWith(".vue")) {
    return [{ code, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: /\.[cm]?tsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(code, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    return [{
      code: block.content,
      offset: block.loc.start.offset,
      lineOffset: block.loc.start.line - 1,
      jsx: block.lang === "jsx" || block.lang === "tsx",
      typescript: block.lang === "ts" || block.lang === "tsx",
    }]
  })
}

function rewriteCliBindings(node: Node, overwrite: (node: Node, text: string) => void): boolean {
  if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") return false
  const replacements = []
  for (const specifier of node.specifiers) {
    const imported = specifier.type === "ImportSpecifier" ? specifier.imported : specifier.type === "ExportSpecifier" ? specifier.local : undefined
    if (!imported) return false
    const name = keyName(imported)
    const renamed = name && cliExports.get(name)
    if (!renamed) return false
    const publicName = specifier.type === "ImportSpecifier" ? specifier.local : specifier.type === "ExportSpecifier" ? specifier.exported : undefined
    replacements.push({ imported, text: publicName && start(imported) === start(publicName) ? `${renamed} as ${name}` : renamed })
  }
  for (const { imported, text } of replacements) overwrite(imported, text)
  return true
}

function migrateSource(file: string, code: string, followUps: FollowUp[]): string {
  const output = new MagicString(code)
  for (const block of scriptBlocks(file, code)) {
    if (!block.code.includes("decisions")) continue
    let program
    try {
      program = parseProgram(block.code, block)
    }
    catch {
      followUps.push({ file, line: block.lineOffset + 1, message: "Could not parse this script. Check its Decisions module references by hand." })
      continue
    }
    const resolveBinding = bindingResolver(program)
    const overwrite = (node: Node, text: string) => output.overwrite(block.offset + start(node), block.offset + end(node), text)
    walk(program, (node) => {
      const source = moduleSource(node)
      if (!source || !modulePattern.test(source.value)) return
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && resolveBinding(node.callee)) return
      if (source.value === `${oldPackage}/cli` && !rewriteCliBindings(node, overwrite)) {
        followUps.push({ file, line: block.lineOffset + line(node), message: "Migrate this CLI module reference by hand: use @vite-hub/choices/cli with listChoices and createChoicesCliNamespace." })
        return
      }
      const quote = block.code.slice(start(source), start(source) + 1)
      overwrite(source, `${quote}${source.value.replace(modulePattern, "$1choices")}${quote}`)
    })
  }
  return output.toString()
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  const changedDependencies = new Set<string>()
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("decisions")) continue
    const after = basename(file) === "package.json" ? migrateManifest(file, code, followUps, changedDependencies) : migrateSource(file, code, followUps)
    if (after !== code) edits.push({ path: file, before: code, after })
  }
  return {
    summary: edits.length ? `renamed Decisions to Choices in ${edits.length} file(s)` : followUps.length ? "found Decisions references that need manual changes" : "found no Decisions references",
    edits,
    followUps,
    notes: [],
    nextSteps: changedDependencies.size ? ["After any dependency follow-ups, run your package manager's install to update the lockfile."] : [],
  }
}

export const choicesPackage: Codemod = {
  name: "choices-package",
  description: "Rename `@vite-hub/decisions` to `@vite-hub/choices`, `vite-hub/decisions` to `vite-hub/choices`, and `vitehub decisions` to `vitehub choices`",
  usage: "[dir]",
  async detect({ cwd }) {
    const { edits, followUps } = await migrate({ cwd })
    const file = edits[0]?.path ?? followUps[0]?.file
    return file ? { reason: `Found a Decisions reference in ${file}` } : undefined
  },
  run: migrate,
}
