import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createTwoFilesPatch } from "diff"

import { codemods } from "./registry.ts"
import { CodemodError } from "./types.ts"

import type { Codemod, CodemodResult } from "./types.ts"

export interface RunCodemodOptions {
  /** Project directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Plan the edits and write nothing. */
  dryRun?: boolean
}

export interface CodemodRun {
  codemod: Codemod
  cwd: string
  dryRun: boolean
  result: CodemodResult
}

export function findCodemod(name: string): Codemod | undefined {
  return codemods.find(codemod => codemod.name === name)
}

/** Runs one codemod. Writes its edits unless `dryRun` is set. Throws `CodemodError` when it cannot migrate. */
export async function runCodemod(name: string, options: RunCodemodOptions = {}): Promise<CodemodRun> {
  const codemod = findCodemod(name)
  if (!codemod) {
    throw new CodemodError(`Unknown codemod "${name}". Available: ${codemods.map(entry => entry.name).join(", ")}.`)
  }
  const cwd = resolve(options.cwd ?? process.cwd())
  const dryRun = options.dryRun ?? false
  const result = await codemod.run({ cwd })
  if (!dryRun) {
    for (const edit of result.edits) {
      const path = resolve(cwd, edit.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, edit.after)
    }
  }
  return { codemod, cwd, dryRun, result }
}

function formatLocation(file: string | undefined, line: number | undefined): string {
  if (!file) return ""
  return line ? `${file}:${line} ` : `${file} `
}

/** Formats the planned edits as unified diffs. */
export function formatDiff(result: CodemodResult): string {
  return result.edits
    .map(edit => createTwoFilesPatch(`a/${edit.path}`, `b/${edit.path}`, edit.before ?? "", edit.after, undefined, undefined, { context: 3 }))
    .join("\n")
}

/** Formats the report that ends every codemod run. */
export function formatReport(run: CodemodRun): string {
  const { codemod, dryRun, result } = run
  const lines = [`${codemod.name}: ${result.summary}`]
  if (dryRun) lines.push("Dry run: no files were written.")
  lines.push("", `${dryRun ? "Files to change" : "Files changed"} (${result.edits.length}):`)
  for (const edit of result.edits) lines.push(`  ${edit.path}${edit.before === undefined ? " (new)" : ""}`)
  if (!result.edits.length) lines.push("  none")
  lines.push("", `Manual follow-ups (${result.followUps.length}):`)
  result.followUps.forEach((followUp, index) => {
    lines.push(`  ${index + 1}. ${formatLocation(followUp.file, followUp.line)}${followUp.message}`)
  })
  if (!result.followUps.length) lines.push("  none")
  if (result.notes.length) {
    lines.push("", "Notes:")
    for (const note of result.notes) lines.push(`  - ${note}`)
  }
  if (result.nextSteps.length) {
    lines.push("", "Next steps:")
    for (const step of result.nextSteps) lines.push(`  - ${step}`)
  }
  return `${lines.join("\n")}\n`
}
