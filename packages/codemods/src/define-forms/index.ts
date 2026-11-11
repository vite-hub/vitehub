import { readFile } from "node:fs/promises"
import { join } from "node:path"

import MagicString from "magic-string"
import { glob } from "tinyglobby"

import { contentFilePattern, rewriteContentFile, rewriteContentImports } from "./content.ts"
import { planDatabaseMoves, rewriteDatabaseReferences } from "./database.ts"
import { rewriteSandboxTasks } from "./sandbox-task.ts"
import { rewriteSchedules } from "./schedule.ts"
import { ignoredPatterns, parseSource, readSourceFiles } from "./shared.ts"

import type { Codemod, CodemodContext, CodemodResult, FileEdit, FollowUp } from "../types.ts"
import type { SourceFile } from "./shared.ts"

/** Files that name Database paths but that the codemod does not parse. */
const configPatterns = ["**/{package.json,wrangler.json,wrangler.jsonc,wrangler.toml,netlify.toml,vercel.json}"]

async function databaseFiles(cwd: string): Promise<string[]> {
  return (await glob(["**/server/databases/**"], { cwd, ignore: ignoredPatterns, dot: false })).sort()
}

interface Counts {
  schedules: number
  sandboxTasks: number
  contentFiles: number
  contentImports: number
}

/** Rewrites the define calls and Content exports of one file. */
function rewriteCode(file: SourceFile, contentFiles: ReadonlySet<string>, counts: Counts, followUps: FollowUp[], migratedContentFiles?: Set<string>): string {
  const parsed = parseSource(file)
  if (!("program" in parsed)) {
    if (/defineSchedule|defineSandboxTask|defineContent/.test(file.code)) followUps.push(parsed)
    return file.code
  }
  const output = new MagicString(file.code)
  counts.schedules += rewriteSchedules(file, parsed, output, followUps)
  counts.sandboxTasks += rewriteSandboxTasks(file, parsed, output, followUps)
  if (contentFiles.has(file.path)) {
    if (rewriteContentFile(file, parsed, output, followUps)) {
      counts.contentFiles++
      migratedContentFiles?.add(file.path)
    }
  }
  return output.toString()
}

async function migrate({ cwd }: CodemodContext): Promise<CodemodResult> {
  const sources = await readSourceFiles(cwd)
  const followUps: FollowUp[] = []
  const notes: string[] = []
  const counts: Counts = { schedules: 0, sandboxTasks: 0, contentFiles: 0, contentImports: 0 }
  const contentFiles = new Set(sources.filter(file => contentFilePattern.test(file.path)).map(file => file.path))

  // The define forms first, then the Database moves on the result, so a moved file keeps both changes.
  const migratedContentFiles = new Set<string>()
  const code = new Map(sources.map(file => [file.path, rewriteCode(file, contentFiles, counts, followUps, migratedContentFiles)]))
  // Only redirect consumers once their named runtime has become the default export.
  for (const file of sources) {
    if (!migratedContentFiles.size) break
    const current = { path: file.path, code: code.get(file.path)! }
    const parsed = parseSource(current)
    if (!("program" in parsed)) continue
    const output = new MagicString(current.code)
    counts.contentImports += rewriteContentImports(current, parsed, migratedContentFiles, output, followUps)
    code.set(file.path, output.toString())
  }

  const paths = await databaseFiles(cwd)
  const plan = planDatabaseMoves(paths, path => (code.get(path) ?? "").includes("defineDatabase"))
  followUps.push(...plan.followUps)
  notes.push(...plan.notes)

  const edits: FileEdit[] = []
  const original = new Map(sources.map(file => [file.path, file.code]))
  for (const file of sources) {
    const current = code.get(file.path)!
    const after = plan.files.size ? rewriteDatabaseReferences({ path: file.path, code: current }, plan, followUps) : current
    const target = plan.files.get(file.path)
    if (target) {
      edits.push({ path: file.path, before: file.code, after: null }, { path: target, before: undefined, after })
    }
    else if (after !== file.code) {
      edits.push({ path: file.path, before: file.code, after })
    }
  }
  // Migrations and other files that are not source code move as they are.
  for (const [from, to] of plan.files) {
    if (original.has(from)) continue
    const text = await readFile(join(cwd, from), "utf8")
    edits.push({ path: from, before: text, after: null }, { path: to, before: undefined, after: text })
  }
  if (plan.files.size) followUps.push(...await configFollowUps(cwd))

  const done = [
    counts.schedules && `${counts.schedules} Schedule(s) to \`defineSchedule({ cron, handler })\``,
    counts.sandboxTasks && `${counts.sandboxTasks} Sandbox Task(s) from \`run\` to \`handler\``,
    counts.contentFiles && `${counts.contentFiles} Content file(s) to a default export`,
    counts.contentImports && `${counts.contentImports} import(s) of \`server/content.ts\``,
    plan.files.size && `${plan.files.size} Database file(s) to \`server/databases/<name>/\``,
  ].filter(Boolean)
  return {
    summary: done.length ? `moved ${done.join(", ")}` : "found no former define form",
    edits,
    followUps,
    notes,
    nextSteps: [
      ...edits.length ? ["Run your typecheck and build."] : [],
      ...plan.files.size ? ["Commit the moved Database files with `git add -A`, so Git records them as renames."] : [],
    ],
  }
}

/** Lines in config files that name the former Database paths. */
async function configFollowUps(cwd: string): Promise<FollowUp[]> {
  const files = (await glob(configPatterns, { cwd, ignore: ignoredPatterns, dot: false })).sort()
  const followUps: FollowUp[] = []
  for (const file of files) {
    const lines = (await readFile(join(cwd, file), "utf8")).split("\n")
    lines.forEach((text, index) => {
      if (/server\/databases\/(?:.*\/)?(?:config|migrations)\b/.test(text)) {
        followUps.push({ file, line: index + 1, message: "This line names a former Database path. Database Definitions are now `server/databases/<name>/index.ts`, with migrations in `server/databases/<name>/migrations/`." })
      }
    })
  }
  return followUps
}

/** The first file that uses a former form, for detection. */
async function detectFormerForm(cwd: string): Promise<string | undefined> {
  const plan = planDatabaseMoves(await databaseFiles(cwd), () => true)
  const [moved] = plan.files.keys()
  if (moved) return `${moved} uses a former Database file layout`
  const sources = await readSourceFiles(cwd)
  const contentFiles = new Set(sources.filter(file => contentFilePattern.test(file.path)).map(file => file.path))
  for (const file of sources) {
    if (!/defineSchedule|defineSandboxTask/.test(file.code) && !contentFiles.has(file.path)) continue
    const counts: Counts = { schedules: 0, sandboxTasks: 0, contentFiles: 0, contentImports: 0 }
    rewriteCode(file, contentFiles, counts, [])
    if (counts.schedules) return `${file.path} calls defineSchedule(cron, handler)`
    if (counts.sandboxTasks) return `${file.path} passes \`run\` to defineSandboxTask()`
    if (counts.contentFiles) return `${file.path} exports \`content\` by name`
  }
  return undefined
}

export const defineForms: Codemod = {
  name: "define-forms",
  description: "Move to one define form: defineSchedule({ cron, handler }), defineSandboxTask({ handler }), a default Content export, and server/databases/<name>/index.ts",
  usage: "[dir]",
  async detect({ cwd }) {
    const reason = await detectFormerForm(cwd)
    return reason ? { reason } : undefined
  },
  run: migrate,
}
