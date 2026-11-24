import { existsSync } from "node:fs"
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"

import { intersects, validRange } from "semver"

import { codemods } from "./registry.ts"
import { applyEdit, checkEditPath, editLabel } from "./runner.ts"
import { readDependencies } from "./shared/detect.ts"
import { findNuxtConfigName, readNuxtConfig } from "./shared/nuxt-config.ts"
import { nodeVersionNote } from "./shared/node-version.ts"
import { readPnpmCatalogVersion } from "./shared/pnpm-catalog.ts"
import { codemodError, isCodemodError } from "./error-diagnostics.ts"

import type { Codemod, CodemodResult, Detection, FileEdit, FollowUp } from "./types.ts"

export interface RunMigrationOptions {
  /** Project directory. Defaults to `process.cwd()`. */
  cwd?: string
  /** Plan the edits and write nothing. */
  dryRun?: boolean
  /** The codemods to detect and run, in order. Defaults to every codemod. `vitehub migrate` passes `upgradeCodemods`. */
  codemods?: readonly Codemod[]
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
  /** Names of the codemods that the migration checked. */
  supported: string[]
}

const skippedFolders = new Set([".git", ".nuxt", ".output", ".data", ".vercel", ".netlify", ".wrangler", "node_modules"])

/** Scratch directory prefix inside the project, so packages and the lockfile resolve as they do from the project. */
export const scratchFolder = ".vitehub-migrate"

async function projectWarnings(cwd: string): Promise<string[]> {
  const nuxt = (await readDependencies(cwd)).get("nuxt")
  if (!nuxt) return []
  const catalog = /^catalog:(.*)$/.exec(nuxt)?.[1]
  const version = catalog === undefined ? nuxt : await readPnpmCatalogVersion(cwd, "nuxt", catalog.trim() || "default")
  if (!version) return []
  const options = { includePrerelease: true }
  const range = validRange(version.replace(/^npm:nuxt(?:-nightly)?@/, ""), options)
  if (range && !intersects(range, ">=5.0.0-0", options)) {
    const source = version === nuxt ? "" : `, which pnpm-workspace.yaml sets to "${version}"`
    return [`ViteHub supports Nuxt 5 and Nitro 3 only, and package.json requires nuxt "${nuxt}"${source}. The migration does not upgrade Nuxt. Move the app to Nuxt 5 before you build it, for example with "nuxt": "npm:nuxt-nightly@5x" until Nuxt 5 is released. Nuxt 5 also stops auto-importing Nitro helpers such as defineEventHandler in server code. Set experimental: { nitroAutoImports: true } to keep them while you migrate, or import them as the Nuxt 5 build error lists.`]
  }
  return []
}

/** Lists every codemod of `candidates` that applies to the project, in their order. */
export async function detectCodemods(cwd: string, candidates: readonly Codemod[] = codemods): Promise<Array<{ codemod: Codemod, detection: Detection }>> {
  const found: Array<{ codemod: Codemod, detection: Detection }> = []
  for (const codemod of candidates) {
    const detection = await codemod.detect({ cwd })
    if (detection) found.push({ codemod, detection })
  }
  return found
}

async function readOptional(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, "utf8") : undefined
}

/**
 * Detects every supported module in the project and runs its codemod. The codemods run one after another on a
 * scratch copy, so each one sees the edits of the ones before it. A codemod that fails adds an error and changes
 * nothing; the others still run. Writes the combined edits unless `dryRun` is set.
 */
export async function runMigration(options: RunMigrationOptions = {}): Promise<Migration> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const dryRun = options.dryRun ?? false
  if (!existsSync(cwd)) throw codemodError(`Cannot find the directory ${cwd}.`)
  const candidates = options.codemods ?? codemods
  const supported = candidates.map(codemod => codemod.name)
  const warnings = await projectWarnings(cwd)
  const nodeNote = nodeVersionNote()
  if (nodeNote) warnings.push(nodeNote)
  const found = await detectCodemods(cwd, candidates)
  const initialDetections = new Map(found.map(({ codemod, detection }) => [codemod, detection]))
  const steps: MigrationStep[] = []
  if (!found.length) {
    if (findNuxtConfigName(cwd)) await readNuxtConfig(cwd)
    else if (!existsSync(join(cwd, "package.json"))) throw codemodError(`Cannot find package.json or nuxt.config in ${cwd}. Pass the app directory as the first argument.`)
    return { cwd, dryRun, steps, edits: [], warnings, supported }
  }
  const touched = new Set<string>()
  const scratch = await mkdtemp(join(cwd, `${scratchFolder}-`))
  try {
    for (const entry of await readdir(cwd)) {
      if (skippedFolders.has(entry) || entry === scratchFolder || entry.startsWith(`${scratchFolder}-`)) continue
      await cp(join(cwd, entry), join(scratch, entry), { recursive: true, filter: source => !skippedFolders.has(basename(source)) })
    }
    const unscratch = (text: string) => text.replaceAll(scratch, cwd)
    for (const codemod of candidates) {
      const detection = codemod.detectAfterEdits && touched.size
        ? await codemod.detect({ cwd: scratch, dependencyRoot: cwd })
        : initialDetections.get(codemod)
      if (!detection) continue
      try {
        const planned = await codemod.run({ cwd: scratch, dependencyRoot: cwd })
        const result: CodemodResult = {
          ...planned,
          summary: unscratch(planned.summary),
          followUps: planned.followUps.map(followUp => ({ ...followUp, message: unscratch(followUp.message) })),
          notes: planned.notes.map(unscratch),
          nextSteps: planned.nextSteps.map(unscratch),
        }
        for (const edit of result.edits) await checkEditPath(scratch, edit.path)
        for (const edit of result.edits) {
          await applyEdit(scratch, edit)
          touched.add(edit.path)
        }
        steps.push({ codemod, detection: { reason: unscratch(detection.reason) }, result })
      }
      catch (error) {
        if (!isCodemodError(error)) throw error
        steps.push({ codemod, detection, error: unscratch(error.message) })
      }
    }
    const edits: FileEdit[] = []
    for (const path of [...touched].sort()) {
      const before = await readOptional(join(cwd, path))
      const after = (await readOptional(join(scratch, path))) ?? null
      if (after !== (before ?? null)) edits.push({ path, before, after })
    }
    if (!dryRun) for (const edit of edits) await applyEdit(cwd, edit)
    return { cwd, dryRun, steps, edits, warnings, supported }
  }
  finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function formatLocation(followUp: FollowUp): string {
  if (!followUp.file) return ""
  return followUp.line ? `${followUp.file}:${followUp.line} ` : `${followUp.file} `
}

/**
 * Formats the report that ends a migration: what each codemod did, what it could not do, and what to run next.
 * `nextSteps` adds steps of the caller after those of the codemods, when the migration changed files.
 */
export function formatMigrationReport(migration: Migration, nextSteps: readonly string[] = []): string {
  const { steps, edits, dryRun } = migration
  const lines: string[] = []
  if (!steps.length) {
    lines.push(`Nothing to migrate in ${migration.cwd}. No codemod applies.`, `Checked: ${migration.supported.join(", ")}.`)
  }
  else {
    const failed = steps.filter(step => step.error).length
    lines.push(`${steps.length} codemod${steps.length === 1 ? " applies" : "s apply"} to ${relative(process.cwd(), migration.cwd) || "."}: migrated ${steps.length - failed}, could not migrate ${failed}.`)
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
    for (const edit of edits) lines.push(`  ${edit.path}${editLabel(edit)}`)
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
  const allNextSteps = [...new Set([...steps.flatMap(step => step.result?.nextSteps ?? []), ...edits.length ? nextSteps : []])]
  if (allNextSteps.length) {
    lines.push("", "Next steps:")
    for (const step of allNextSteps) lines.push(`  - ${step}`)
  }
  return `${lines.join("\n")}\n`
}
