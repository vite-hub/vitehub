import { existsSync } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { codemods } from "./registry.ts"
import { readDependencies } from "./shared/detect.ts"
import { CodemodError } from "./types.ts"

import type { Codemod, CodemodResult, Detection, FileEdit, FollowUp } from "./types.ts"

export interface RunMigrationOptions {
  /** Project directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Plan the edits and write nothing. */
  dryRun?: boolean
}

/** One codemod that the migration ran. It has a `result` or an `error`. */
export interface MigrationStep {
  codemod: Codemod
  detection: Detection
  result?: CodemodResult
  /** Why the codemod could not migrate. Its edits are not applied. */
  error?: string
}

export interface Migration {
  cwd: string
  dryRun: boolean
  steps: MigrationStep[]
  /** The combined edits of every step that succeeded, against the files as they were before the migration. */
  edits: FileEdit[]
  /** Problems with the project that no codemod owns, such as a Nuxt version that ViteHub does not support. */
  warnings: string[]
}

/** Folders that the migration does not copy into its scratch directory. */
const skippedFolders = new Set([".git", ".nuxt", ".output", ".data", ".vercel", ".netlify", ".wrangler", "node_modules"])

/** Scratch directory prefix inside the project, so packages and the lockfile resolve as they do from the project. */
export const scratchFolder = ".vitehub-migrate"

/** The Nuxt major versions that a `nuxt` dependency range allows, when the range is a plain one. */
function nuxtMajors(range: string): number[] | undefined {
  if (/nuxt-nightly@5|nuxt-nightly@\^?5/.test(range)) return [5]
  const matches = [...range.matchAll(/(?:^|[\s|^~>=<v])(\d+)(?:\.|$|\s|x)/g)].map(match => Number(match[1]))
  return matches.length ? [...new Set(matches)] : undefined
}

async function projectWarnings(cwd: string): Promise<string[]> {
  const nuxt = (await readDependencies(cwd)).get("nuxt")
  if (!nuxt) return []
  const majors = nuxtMajors(nuxt)
  if (majors && majors.every(major => major < 5)) {
    return [`ViteHub supports Nuxt 5 and Nitro 3 only, and package.json requires nuxt "${nuxt}". The migration does not upgrade Nuxt. Move the app to Nuxt 5 before you build it, for example with "nuxt": "npm:nuxt-nightly@5x" until Nuxt 5 is released. Nuxt 5 does not auto-import Nitro helpers in server code, so import defineEventHandler and the other h3 helpers from "nitro/h3".`]
  }
  return []
}

/** Lists every codemod that applies to the project, in registry order. */
export async function detectCodemods(cwd: string): Promise<Array<{ codemod: Codemod, detection: Detection }>> {
  const found: Array<{ codemod: Codemod, detection: Detection }> = []
  for (const codemod of codemods) {
    const detection = await codemod.detect({ cwd })
    if (detection) found.push({ codemod, detection })
  }
  return found
}

async function readOptional(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, "utf8") : undefined
}

async function checkScratchEdit(scratch: string, file: string): Promise<void> {
  const local = relative(scratch, resolve(scratch, file))
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new CodemodError(`Cannot migrate ${file}: the edit is outside the project.`)
  }
  let path = scratch
  for (const part of local.split(sep)) {
    path = join(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new CodemodError(`Cannot migrate ${file}: it is a symbolic link or is inside a symbolic link. Replace the link with a local file or directory before migrating.`)
      }
    }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return
      throw error
    }
  }
}

/**
 * Detects every supported module in the project and runs its codemod. The codemods run one after another on a
 * scratch copy, so each one sees the edits of the ones before it. A codemod that fails adds an error and changes
 * nothing; the others still run. Writes the combined edits unless `dryRun` is set.
 */
export async function runMigration(options: RunMigrationOptions = {}): Promise<Migration> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const dryRun = options.dryRun ?? false
  if (!existsSync(cwd)) throw new CodemodError(`Cannot find the directory ${cwd}.`)
  const warnings = await projectWarnings(cwd)
  const found = await detectCodemods(cwd)
  const steps: MigrationStep[] = []
  if (!found.length) return { cwd, dryRun, steps, edits: [], warnings }
  const touched = new Set<string>()
  const scratch = await mkdtemp(join(cwd, `${scratchFolder}-`))
  try {
    // fs.cp refuses to copy a directory into itself, so copy each top-level entry.
    for (const entry of await readdir(cwd)) {
      if (skippedFolders.has(entry) || entry === scratchFolder || entry.startsWith(`${scratchFolder}-`)) continue
      await cp(join(cwd, entry), join(scratch, entry), { recursive: true, filter: source => !skippedFolders.has(basename(source)) })
    }
    // Messages name files in the scratch copy. Show the project paths instead.
    const unscratch = (text: string) => text.replaceAll(scratch, cwd)
    for (const { codemod, detection } of found) {
      try {
        const planned = await codemod.run({ cwd: scratch })
        const result: CodemodResult = {
          ...planned,
          summary: unscratch(planned.summary),
          followUps: planned.followUps.map(followUp => ({ ...followUp, message: unscratch(followUp.message) })),
          notes: planned.notes.map(unscratch),
          nextSteps: planned.nextSteps.map(unscratch),
        }
        // Reject the full batch before writing: copied symlinks can still point at the original files.
        for (const edit of result.edits) await checkScratchEdit(scratch, edit.path)
        for (const edit of result.edits) {
          const path = join(scratch, edit.path)
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, edit.after)
          touched.add(edit.path)
        }
        steps.push({ codemod, detection, result })
      }
      catch (error) {
        if (!(error instanceof CodemodError)) throw error
        steps.push({ codemod, detection, error: unscratch(error.message) })
      }
    }
    const edits: FileEdit[] = []
    for (const path of [...touched].sort()) {
      const before = await readOptional(join(cwd, path))
      const after = await readFile(join(scratch, path), "utf8")
      if (after !== before) edits.push({ path, before, after })
    }
    if (!dryRun) {
      for (const edit of edits) {
        const path = join(cwd, edit.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, edit.after)
      }
    }
    return { cwd, dryRun, steps, edits, warnings }
  }
  finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function formatLocation(followUp: FollowUp): string {
  if (!followUp.file) return ""
  return followUp.line ? `${followUp.file}:${followUp.line} ` : `${followUp.file} `
}

/** Formats the report that ends a migration: what each codemod did, what it could not do, and what to run next. */
export function formatMigrationReport(migration: Migration): string {
  const { steps, edits, dryRun } = migration
  const lines: string[] = []
  const supported = codemods.map(codemod => codemod.name).join(", ")
  if (!steps.length) {
    lines.push(`No supported module found in ${migration.cwd}.`, `Supported: ${supported}.`)
  }
  else {
    const failed = steps.filter(step => step.error).length
    lines.push(`Found ${steps.length} supported module${steps.length === 1 ? "" : "s"} in ${relative(process.cwd(), migration.cwd) || "."}: migrated ${steps.length - failed}, could not migrate ${failed}.`)
  }
  if (dryRun) lines.push("Dry run: no files were written.")
  for (const step of steps) {
    lines.push("", `${step.codemod.name} (${step.detection.reason})`)
    lines.push(step.result ? `  ${step.result.summary}` : `  Not migrated: ${step.error}`)
  }
  if (migration.warnings.length) {
    lines.push("", "Warnings:")
    for (const warning of migration.warnings) lines.push(`  - ${warning}`)
  }
  if (steps.length) {
    lines.push("", `${dryRun ? "Files to change" : "Files changed"} (${edits.length}):`)
    for (const edit of edits) lines.push(`  ${edit.path}${edit.before === undefined ? " (new)" : ""}`)
    if (!edits.length) lines.push("  none")
  }
  const followUps = steps.flatMap(step => (step.result?.followUps ?? []).map(followUp => ({ name: step.codemod.name, followUp })))
  if (steps.some(step => step.result)) {
    lines.push("", `Manual follow-ups (${followUps.length}):`)
    followUps.forEach(({ name, followUp }, index) => lines.push(`  ${index + 1}. [${name}] ${formatLocation(followUp)}${followUp.message}`))
    if (!followUps.length) lines.push("  none")
  }
  const notes = steps.flatMap(step => (step.result?.notes ?? []).map(note => `[${step.codemod.name}] ${note}`))
  if (notes.length) {
    lines.push("", "Notes:")
    for (const note of notes) lines.push(`  - ${note}`)
  }
  const nextSteps = [...new Set(steps.flatMap(step => step.result?.nextSteps ?? []))]
  if (nextSteps.length) {
    lines.push("", "Next steps:")
    for (const step of nextSteps) lines.push(`  - ${step}`)
  }
  return `${lines.join("\n")}\n`
}
