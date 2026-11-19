import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { end, keyName, line, parseProgram, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"
import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { unwrapExpression } from "../shared/nuxt-config.ts"

import type { File, ObjectExpression } from "@babel/types"
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

function property(object: ObjectExpression, name: string) {
  return object.properties.find(item => item.type === "ObjectProperty" && !item.computed && keyName(item.key) === name)
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const edits: FileEdit[] = []
  const followUps: FollowUp[] = []
  for (const file of (await glob(sourcePatterns, { cwd, ignore: ignoredPatterns })).sort()) {
    const code = await readFile(join(cwd, file), "utf8")
    if (!code.includes("repository") || !/driver\s*:\s*["'`]github["'`]/.test(code)) continue
    const output = new MagicString(code)
    let changed = false
    for (const block of scripts(file, code)) {
      let program: File
      try {
        program = parseProgram(block.code, { jsx: block.jsx, typescript: block.typescript })
      }
      catch {
        continue
      }
      walk(program, (node) => {
        // A GitHub Workspace Store: `store: { driver: "github", repository }`.
        if (node.type !== "ObjectExpression") return
        const driver = property(node, "driver")
        const driverValue = driver?.type === "ObjectProperty" ? unwrapExpression(driver.value) : undefined
        if (driverValue?.type !== "StringLiteral" || driverValue.value !== "github") return
        const repository = property(node, "repository")
        if (repository?.type !== "ObjectProperty") return
        if (property(node, "repo")) {
          followUps.push({ file, line: block.lineOffset + line(repository), message: "This GitHub Workspace Store sets both `repo` and `repository`. Remove `repository`: the Store reads only `repo`." })
          return
        }
        const text = repository.shorthand ? "repo: repository" : `repo: ${block.code.slice(start(repository.value), end(repository.value))}`
        output.overwrite(block.offset + start(repository), block.offset + end(repository), text)
        changed = true
      })
    }
    if (changed) edits.push({ path: file, before: code, after: output.toString() })
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
