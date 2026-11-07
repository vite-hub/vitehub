import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
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
  await mkdir(directory, { recursive: true })
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
    expect((await readdir(wizard)).filter(entry => entry.startsWith(scratchFolder))).toEqual([])
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
    expect((await readdir(directory)).filter(entry => entry.startsWith(scratchFolder))).toEqual([])
  })

  it.each([false, true])("preserves an existing scratch directory (supported module: %s)", async (supported) => {
    const directory = await app(`existing-scratch-${supported}`, {
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ['${supported ? "nuxt-safe-runtime-config" : "@nuxt/ui"}'] })\n`,
      [`${scratchFolder}/keep.txt`]: "user data\n",
    })
    const migration = await runMigration({ cwd: directory })
    expect(await readFile(join(directory, scratchFolder, "keep.txt"), "utf8")).toBe("user data\n")
    expect(migration.steps).toHaveLength(supported ? 1 : 0)
    expect((await readdir(directory)).filter(entry => entry.startsWith(scratchFolder))).toEqual([scratchFolder])
  })

  it("does not write through a symlinked config during a dry run", async () => {
    const code = "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n"
    const target = await app("linked-config-target", { "config.ts": code })
    const directory = await app("linked-config", { "package.json": "{}\n" })
    await symlink(join(target, "config.ts"), join(directory, "nuxt.config.ts"))
    const migration = await runMigration({ cwd: directory, dryRun: true })
    expect(await readFile(join(target, "config.ts"), "utf8")).toBe(code)
    expect(migration.steps[0]?.error).toContain("symbolic link")
    expect(migration.edits).toEqual([])
  })

  it("does not write through a symlinked parent directory during a dry run", async () => {
    const directory = await copyFixture("env-schema", "linked-directory")
    const code = "export const secret = useSafeRuntimeConfig().apiSecret\n"
    const target = await app("linked-directory-target", { "api/secret.get.ts": code })
    const config = await readFile(join(directory, "nuxt.config.ts"), "utf8")
    await rm(join(directory, "server"), { recursive: true })
    await symlink(target, join(directory, "server"), "dir")
    const migration = await runMigration({ cwd: directory, dryRun: true })
    expect(await readFile(join(target, "api/secret.get.ts"), "utf8")).toBe(code)
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(migration.steps[0]?.error).toContain("symbolic link")
    expect(migration.edits).toEqual([])
  })

  it("reports an app without supported modules and changes nothing", async () => {
    const directory = await app("none", { "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxt/ui'] })\n" })
    const migration = await runMigration({ cwd: directory })
    expect(migration.steps).toEqual([])
    expect(formatMigrationReport(migration)).toContain(`No supported module found in ${directory}.\nSupported: nuxt-safe-runtime-config.`)
  })

  it.each([
    ["empty directory", {}, "Cannot find nuxt.config"],
    ["non-Nuxt project", { "package.json": '{"dependencies":{"vue":"^3.5.0"}}\n' }, "Cannot find nuxt.config"],
    ["invalid config", { "nuxt.config.ts": "export default defineNuxtConfig({" }, "Cannot parse nuxt.config.ts"],
  ])("rejects %s without supported modules", async (name, files, message) => {
    const directory = await app(name, files)
    const result = await cli([directory])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(message)
    expect(result.stdout).toBe("")
    expect((await readdir(directory)).sort()).toEqual(Object.keys(files).sort())
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
