import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { createTwoFilesPatch } from "diff"

import { codemods } from "./registry.ts"
import { codemodError, codemodsErrorDiagnostics } from "./error-diagnostics.ts"
import { nodeVersionNote } from "./shared/node-version.ts"
import { planNitro3 } from "./shared/nuxt-version.ts"

import type { Nitro3Plan } from "./shared/nuxt-version.ts"
import type { Codemod, CodemodResult, FileEdit } from "./types.ts"

export interface RunCodemodOptions {
  /** Project directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Plan the edits and write nothing. */
  dryRun?: boolean
  /** On a Nuxt version before 4.7, set `nuxt` to `npm:nuxt-nightly@5x` in package.json instead of stopping. */
  nuxtNightly?: boolean
}

export interface CodemodRun {
  codemod: Codemod
  cwd: string
  dryRun: boolean
  result: CodemodResult
}

/**
 * Rejects an edit outside `root` or through a symbolic link, such as a linked config or a file inside a linked
 * directory. Writing it would change a file outside the project.
 */
export async function checkEditPath(root: string, file: string): Promise<void> {
  const local = relative(root, resolve(root, file))
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw codemodError(`Cannot migrate ${file}: the edit is outside the project.`)
  }
  let path = root
  for (const part of local.split(sep)) {
    path = join(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw codemodError(`Cannot migrate ${file}: it is a symbolic link or is inside a symbolic link. Replace the link with a local file or directory before migrating.`)
      }
    }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    }
  }
}

/** Writes one planned edit below `root`, or deletes the file when `after` is `null`. */
export async function applyEdit(root: string, edit: FileEdit): Promise<void> {
  const path = resolve(root, edit.path)
  if (edit.after === null) {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, edit.after)
}

export function findCodemod(name: string): Codemod | undefined {
  return codemods.find(codemod => codemod.name === name)
}

/**
 * Runs one codemod. Writes its edits unless `dryRun` is set. Throws `CODEMODS_BLOCKED` when it cannot migrate, also when an
 * edit is a symbolic link or is inside one, and `CODEMODS_NUXT_UNSUPPORTED` when it adds `vite-hub/nuxt` to an app on a
 * Nuxt version before 4.7 without `nuxtNightly`. On Nuxt 4.7 without `nitro`, it adds `nitro` to package.json.
 */
export async function runCodemod(name: string, options: RunCodemodOptions = {}): Promise<CodemodRun> {
  const codemod = findCodemod(name)
  if (!codemod) {
    throw codemodsErrorDiagnostics.CODEMODS_UNKNOWN({ available: codemods.map(entry => entry.name), name })
  }
  const cwd = resolve(options.cwd ?? process.cwd())
  const dryRun = options.dryRun ?? false
  const planned = await codemod.run({ cwd })
  const nitro3 = planned.requiresNitro3 ? await planNitro3(cwd, [codemod.name], options.nuxtNightly ?? false) : undefined
  const upgraded = nitro3 ? await withNitro3(cwd, planned, nitro3) : planned
  const nodeNote = nodeVersionNote()
  const result = nodeNote ? { ...upgraded, notes: [...upgraded.notes, nodeNote] } : upgraded
  // Check on a dry run too, so it fails where the real run would.
  for (const edit of result.edits) await checkEditPath(cwd, edit.path)
  if (!dryRun) {
    for (const edit of result.edits) await applyEdit(cwd, edit)
  }
  return { codemod, cwd, dryRun, result }
}

async function withNitro3(cwd: string, result: CodemodResult, plan: Nitro3Plan): Promise<CodemodResult> {
  const path = "package.json"
  const edits = result.edits.map(edit => edit.path === path && edit.after !== null ? { ...edit, after: plan.update(edit.after) } : edit)
  if (!result.edits.some(edit => edit.path === path)) {
    const before = await readFile(join(cwd, path), "utf8")
    edits.push({ path, before, after: plan.update(before) })
  }
  return { ...result, edits, notes: [plan.note, ...result.notes] }
}

/** Marks a new or deleted file in a file list. */
export function editLabel(edit: FileEdit): string {
  if (edit.after === null) return " (deleted)"
  return edit.before === undefined ? " (new)" : ""
}

function formatLocation(file: string | undefined, line: number | undefined): string {
  if (!file) return ""
  return line ? `${file}:${line} ` : `${file} `
}

/** Formats the planned edits as unified diffs. */
export function formatDiff(result: Pick<CodemodResult, "edits">): string {
  return result.edits
    .map(edit => createTwoFilesPatch(edit.before === undefined ? "/dev/null" : `a/${edit.path}`, edit.after === null ? "/dev/null" : `b/${edit.path}`, edit.before ?? "", edit.after ?? "", undefined, undefined, { context: 3 }))
    .join("\n")
}

/** Formats the report that ends every codemod run. */
export function formatReport(run: CodemodRun): string {
  const { codemod, dryRun, result } = run
  const lines = [`${codemod.name}: ${result.summary}`]
  if (dryRun) lines.push("Dry run: no files were written.")
  lines.push("", `${dryRun ? "Files to change" : "Files changed"} (${result.edits.length}):`)
  for (const edit of result.edits) lines.push(`  ${edit.path}${editLabel(edit)}`)
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
