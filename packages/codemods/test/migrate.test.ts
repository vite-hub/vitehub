import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { formatMigrationReport, runCli, runCodemod, runMigration } from "../src/index.ts"
import { scratchFolder } from "../src/migrate.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, "test/fixtures")
const scratch = join(packageRoot, ".tmp/migrate-test")

async function copyFixture(name: string, target: string): Promise<string> {
  const directory = join(scratch, target)
  await rm(directory, { recursive: true, force: true })
  await cp(join(fixtures, name, "input"), directory, { recursive: true })
  return directory
}

async function app(name: string, files: Record<string, string>): Promise<string> {
  const directory = join(scratch, name)
  await rm(directory, { recursive: true, force: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true })
    await writeFile(join(directory, path), content)
  }
  return directory
}

async function cli(args: string[]) {
  let stdout = ""
  let stderr = ""
  const code = await runCli(args, { stdout: text => stdout += text, stderr: text => stderr += text })
  return { code, stdout, stderr }
}

afterAll(() => rm(scratch, { recursive: true, force: true }))

describe("migrate", () => {
  it("detects nuxt-safe-runtime-config and writes what the codemod writes alone", async () => {
    const wizard = await copyFixture("env-schema", "wizard")
    const single = await copyFixture("env-schema", "single")
    const migration = await runMigration({ cwd: wizard })
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: single })
    expect(migration.steps.map(step => [step.codemod.name, step.detection.reason, step.error])).toEqual([
      ["nuxt-safe-runtime-config", "nuxt.config.ts lists nuxt-safe-runtime-config in modules", undefined],
    ])
    expect(migration.edits.map(edit => edit.path).sort()).toEqual(run.result.edits.map(edit => edit.path).sort())
    for (const edit of run.result.edits) expect(await readFile(join(wizard, edit.path), "utf8")).toBe(edit.after)
    expect(migration.steps[0]?.result?.followUps).toEqual(run.result.followUps)
    expect(await readdir(wizard)).not.toContain(scratchFolder)
  })

  it("writes nothing in a dry run and prints the combined diff", async () => {
    const directory = await copyFixture("valibot-schema", "dry-run")
    const before = await readFile(join(directory, "nuxt.config.ts"), "utf8")
    const result = await cli([directory, "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--- a/nuxt.config.ts\n+++ b/nuxt.config.ts")
    expect(result.stdout).toContain("Found 1 supported module in")
    expect(result.stdout).toContain("Dry run: no files were written.")
    expect(result.stdout).toMatch(/Manual follow-ups \(\d+\):\n {2}1\. \[nuxt-safe-runtime-config\] /)
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toBe(before)
    expect(await readdir(directory)).not.toContain(scratchFolder)
  })

  it("reports an app without supported modules and changes nothing", async () => {
    const directory = await app("none", { "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/ui'] })\n" })
    const migration = await runMigration({ cwd: directory })
    expect(migration.steps).toEqual([])
    expect(formatMigrationReport(migration)).toContain(`No supported module found in ${directory}.\nSupported: nuxt-safe-runtime-config.`)
  })

  it("explains a codemod that cannot migrate, writes nothing for it, and exits with 1", async () => {
    const directory = await app("fails", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example' } })\n",
    })
    const result = await cli([directory])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("migrated 0, could not migrate 1.")
    expect(result.stdout).toContain("nuxt-safe-runtime-config (nuxt.config.ts lists nuxt-safe-runtime-config in modules)\n  Not migrated: Cannot find the envSchema file .env.example.")
    expect(result.stdout).toContain("Files changed (0):\n  none")
    expect(result.stdout).not.toContain(scratchFolder)
  })

  it("shows project paths, not the scratch copy, in messages", async () => {
    const directory = await app("paths", {
      "nuxt.config.ts": "import missing from 'not-installed-anywhere'\nexport default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { $schema: missing } })\n",
    })
    const migration = await runMigration({ cwd: directory, dryRun: true })
    expect(migration.steps[0]?.error).toContain(`Cannot load ${join(directory, "nuxt.config.ts")} to read the $schema`)
    expect(migration.steps[0]?.error).not.toContain(scratchFolder)
  })

  it("warns when the app requires a Nuxt version before 5", async () => {
    const directory = await app("nuxt-4", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n",
      "package.json": `${JSON.stringify({ dependencies: { "nuxt": "^4.2.0", "nuxt-safe-runtime-config": "^0.3.2" } })}\n`,
    })
    const migration = await runMigration({ cwd: directory, dryRun: true })
    expect(migration.warnings).toEqual([expect.stringContaining("ViteHub supports Nuxt 5 and Nitro 3 only, and package.json requires nuxt \"^4.2.0\".")])
    const nightly = await app("nuxt-5", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n",
      "package.json": `${JSON.stringify({ dependencies: { "nuxt": "npm:nuxt-nightly@5x", "nuxt-safe-runtime-config": "^0.3.2" } })}\n`,
    })
    expect((await runMigration({ cwd: nightly, dryRun: true })).warnings).toEqual([])
  })
})
