import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { codemods, detectCodemods, formatMigrationReport, runCli, runCodemod, runMigration, upgradeCodemods } from "../src/index.ts"
import { scratchFolder } from "../src/migrate.ts"
import { nuxtSafeRuntimeConfig } from "../src/nuxt-safe-runtime-config/index.ts"

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
  it("reports manual Queue migration even when there are no edits", async () => {
    const cwd = await app("queue-spread-arguments", {
      "server/queues/report.ts": "const legacyArgs = [() => {}, { concurrency: 2 }] as const\nexport default defineQueue(...legacyArgs)\n",
    })
    const migration = await runMigration({ cwd, dryRun: true })
    expect(migration.edits).toEqual([])
    expect(formatMigrationReport(migration)).toContain("Check this Queue call's arguments.")
  })

  it("reports installed NuxtHub dependents through the scratch migration", async () => {
    const cwd = await app("installed-nuxthub-dependent", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'] })\n",
      "package.json": JSON.stringify({ dependencies: { "@nuxthub/core": "0.10.0", "uses-hub": "1.0.0" } }),
      "node_modules/uses-hub/package.json": JSON.stringify({ peerDependencies: { "@nuxthub/core": "*" } }),
    })
    const migration = await runMigration({ cwd, dryRun: true })
    expect(migration.steps[0]?.error).toBeUndefined()
    expect(migration.steps[0]?.result?.followUps).toContainEqual(expect.objectContaining({
      file: "package.json",
      message: expect.stringContaining("uses-hub needs @nuxthub/core"),
    }))
  })

  it("reports hooks in CommonJS app and layer configs", async () => {
    const cwd = await app("commonjs-nuxthub-hooks", {
      "nuxt.config.cjs": "export default { modules: ['@nuxthub/core'], hooks: { 'hub:db:schema:extend': () => {} } }\n",
      "layers/base/nuxt.config.cjs": "export default { hooks: { 'hub:db:migrations:dirs': () => {} } }\n",
    })
    const result = await runCodemod("nuxthub", { cwd, dryRun: true })
    expect(result.result.followUps).toContainEqual(expect.objectContaining({ file: "nuxt.config.cjs", line: 1, message: expect.stringContaining("hub:db:schema:extend") }))
    expect(result.result.followUps).toContainEqual(expect.objectContaining({ file: "layers/base/nuxt.config.cjs", line: 1, message: expect.stringContaining("hub:db:migrations:dirs") }))
  })

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

  const catalogWorkspace = "catalog:\n  vite-hub: ^0.5.1\ncatalogs:\n  tools:\n    vite-hub: npm:vite-hub@>=0.5.1 <1\n  old:\n    vite-hub: ^0.4.0\n"

  it.each([
    ["0.4.1", undefined],
    ["^0.5.0", undefined],
    ["^0.4.0", undefined],
    ["npm:vite-hub@^0.4.0", undefined],
    ["catalog:old", catalogWorkspace],
  ])("leaves an envSchema app unchanged with vite-hub %s", async (range, workspace) => {
    const cwd = await copyFixture("env-schema", `env-schema-incompatible-${range.replace(/\W/g, "_")}`)
    const manifest = JSON.stringify({ dependencies: { "nuxt-safe-runtime-config": "^1.0.0", "vite-hub": range } })
    await writeFile(join(cwd, "package.json"), manifest)
    if (workspace) await writeFile(join(cwd, "pnpm-workspace.yaml"), workspace)
    const config = await readFile(join(cwd, "nuxt.config.ts"), "utf8")
    await expect(runCodemod("nuxt-safe-runtime-config", { cwd })).rejects.toThrow("vite-hub/env/vite")
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toBe(config)
    expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(manifest)
  })

  it.each([
    ["catalog:", false],
    ["catalog:default", false],
    ["catalog:tools", false],
    ["npm:vite-hub@^0.5.1", false],
    ["catalog:missing", true],
    ["workspace:*", true],
    ["workspace:^0.5.1", true],
    ["link:../vite-hub", true],
    ["file:../vite-hub.tgz", true],
    ["https://pkg.pr.new/vite-hub@5bd5f98", true],
    ["latest", true],
  ])("keeps vite-hub %s when migrating envSchema", async (range, followUp) => {
    const cwd = await copyFixture("env-schema", `env-schema-readable-${range.replace(/\W/g, "_")}`)
    await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { "nuxt-safe-runtime-config": "^1.0.0", "vite-hub": range } }))
    await writeFile(join(cwd, "pnpm-workspace.yaml"), catalogWorkspace)
    const { result } = await runCodemod("nuxt-safe-runtime-config", { cwd })
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toContain("vite-hub/env/vite")
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))).toEqual({ dependencies: { "vite-hub": range } })
    const versionFollowUps = result.followUps.filter(entry => entry.file === "package.json" && entry.message.includes("vite-hub/env/vite needs vite-hub >=0.5.1 <1"))
    expect(versionFollowUps).toHaveLength(followUp ? 1 : 0)
  })

  it("keeps a compatible vite-hub pin when migrating envSchema", async () => {
    const cwd = await copyFixture("env-schema", "env-schema-compatible")
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      dependencies: { "nuxt-safe-runtime-config": "^1.0.0" },
      devDependencies: { "vite-hub": "0.5.1" },
    }))
    await runCodemod("nuxt-safe-runtime-config", { cwd })
    expect(await readFile(join(cwd, "nuxt.config.ts"), "utf8")).toContain("vite-hub/env/vite")
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))).toEqual({
      dependencies: {},
      devDependencies: { "vite-hub": "0.5.1" },
    })
  })

  it("writes nothing in a dry run and prints the combined diff", async () => {
    const directory = await copyFixture("valibot-schema", "dry-run")
    const before = await readFile(join(directory, "nuxt.config.ts"), "utf8")
    const result = await cli([directory, "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--- a/nuxt.config.ts\n+++ b/nuxt.config.ts")
    expect(result.stdout).toContain("1 codemod applies to")
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

  it("does not write through a symlinked config when it runs one codemod", async () => {
    const code = "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n"
    const target = await app("linked-config-single-target", { "config.ts": code })
    const directory = await app("linked-config-single", { "package.json": "{}\n" })
    await symlink(join(target, "config.ts"), join(directory, "nuxt.config.ts"))
    const name = nuxtSafeRuntimeConfig.name
    await expect(runCodemod(name, { cwd: directory, dryRun: true })).rejects.toThrow("symbolic link")
    await expect(runCodemod(name, { cwd: directory })).rejects.toThrow("symbolic link")
    expect(await readFile(join(target, "config.ts"), "utf8")).toBe(code)
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
    expect(formatMigrationReport(migration)).toContain(`Nothing to migrate in ${directory}. No codemod applies.\nChecked: ${codemods.map(codemod => codemod.name).join(", ")}.`)
  })

  it("migrates a plain Node app that has no nuxt.config", async () => {
    const directory = await app("plain-node", {
      "package.json": '{"type":"module","dependencies":{"vite-hub":"0.0.9"}}\n',
      "vite.config.ts": "import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({ preset: 'node' })] }\n",
      "src/job.ts": "import { runQueue } from 'vite-hub/queue'\nexport const job = () => runQueue('mail', {})\n",
    })
    const result = await cli([directory])
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(result.stdout).toContain("2 codemods apply to")
    expect(await readFile(join(directory, "vite.config.ts"), "utf8")).toContain("vitehub({ host: 'node' })")
    expect(await readFile(join(directory, "src/job.ts"), "utf8")).toContain("sendQueue('mail', {})")
  })

  it("reports a plain Node app with nothing to migrate and exits with 0", async () => {
    const files = { "package.json": '{"dependencies":{"vue":"^3.5.0"}}\n', "src/index.ts": "export const a = 1\n" }
    const directory = await app("plain-current", files)
    const result = await cli([directory])
    expect(result).toMatchObject({ code: 0, stderr: "" })
    expect(result.stdout).toContain(`Nothing to migrate in ${directory}.`)
    expect((await readdir(directory)).sort()).toEqual(["package.json", "src"])
  })

  it.each([
    ["empty directory", {}, "Cannot find package.json or nuxt.config in"],
    ["invalid config", { "nuxt.config.ts": "export default defineNuxtConfig({" }, "Cannot parse nuxt.config.ts"],
    ["invalid config with a provider comment", { "nuxt.config.ts": "export default defineNuxtConfig({\n  // provider\n" }, "Cannot parse nuxt.config.ts"],
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

  it.each([
    ["catalog:", "catalog:\n  vue: ^3.5.0\n  nuxt: ^4.2.0 # pinned\n", "^4.2.0"],
    ["catalog:default", "catalogs:\n  default:\n    nuxt: '>=4.0.0 <5'\n", ">=4.0.0 <5"],
    ["catalog:frameworks", "packages:\n  - apps/*\ncatalog:\n  nuxt: npm:nuxt-nightly@5x\ncatalogs:\n  frameworks:\n    \"nuxt\": ~4.1.0\n  tools:\n    nuxt: ^5.0.0\n", "~4.1.0"],
    ["catalog:", "catalog:\n  nuxt: npm:nuxt-nightly@5x\ncatalogs:\n  old:\n    nuxt: ^4.2.0\n", undefined],
  ])("reads nuxt \"%s\" from pnpm-workspace.yaml", async (nuxt, workspace, warnsFor) => {
    const directory = await app(`nuxt-${encodeURIComponent(nuxt)}-${warnsFor ?? "5"}`, {
      "pnpm-workspace.yaml": workspace,
      "apps/web/nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "apps/web/package.json": `${JSON.stringify({ dependencies: { nuxt } })}\n`,
    })
    const migration = await runMigration({ cwd: join(directory, "apps/web"), dryRun: true })
    if (!warnsFor) return expect(migration.warnings).toEqual([])
    expect(migration.warnings).toEqual([expect.stringContaining(`package.json requires nuxt "${nuxt}", which pnpm-workspace.yaml sets to "${warnsFor}".`)])
  })

  it.each([
    ["<5", true],
    ["<=3", true],
    [">=3 <5", true],
    ["^3 || ^5", false],
    [">=3", false],
    ["5.0.0-beta.1", false],
    ["npm:nuxt-nightly@5x", false],
    ["latest", false],
  ])("checks the allowed Nuxt versions in %s", async (nuxt, warns) => {
    const directory = await app(`nuxt-range-${encodeURIComponent(nuxt)}`, {
      "nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "package.json": `${JSON.stringify({ dependencies: { nuxt } })}\n`,
    })
    const migration = await runMigration({ cwd: directory, dryRun: true })
    expect(migration.warnings).toHaveLength(warns ? 1 : 0)
    if (warns) expect(migration.warnings[0]).toContain(`package.json requires nuxt "${nuxt}"`)
  })

  it.each([
    ["external", "extends: ['../layers/shared'],"],
    ["absolute", `extends: [${JSON.stringify(join(scratch, "schema-free-layer-absolute/layers/shared"))}],`],
    ["tuple", "extends: [['../layers/shared', {}]],"],
    ["dynamic", "extends: activeLayers,"],
    ["package", "extends: ['@example/nuxt-layer'],"],
    ["remote", "extends: ['github:example/nuxt-layer'],"],
    ["local", "extends: ['./layers/base'],"],
    ["automatic", ""],
    ["spread", "...{ extends: ['../layers/shared'] },"],
  ])("keeps a schema-free module with %s layers", async (name, extendsOption) => {
    const files = {
      "app/nuxt.config.ts": `const activeLayers = ['../layers/shared']\nexport default defineNuxtConfig({ ${extendsOption} modules: ['nuxt-safe-runtime-config'] })\n`,
      "app/package.json": '{"dependencies":{"nuxt-safe-runtime-config":"^0.3.2"}}\n',
      ...(name === "automatic" || name === "local" ? { "app/layers/base/nuxt.config.ts": "export default defineNuxtConfig({ extends: ['../../../layers/shared'] })\n" } : {}),
      "layers/shared/nuxt.config.ts": "export default defineNuxtConfig({})\n",
      "layers/shared/composables/config.ts": "export const config = () => useSafeRuntimeConfig()\n",
    }
    const root = await app(`schema-free-layer-${name}`, files)
    const directory = join(root, "app")
    for (const args of [[directory], ["nuxt-safe-runtime-config", directory]]) {
      const result = await cli(args)
      expect(result.code).toBe(1)
      expect(result.stdout + result.stderr).toContain("cannot verify inherited schemas or useSafeRuntimeConfig() calls")
      for (const [file, content] of Object.entries(files)) expect(await readFile(join(root, file), "utf8")).toBe(content)
    }
  })

  it("removes a schema-free module when extends is empty", async () => {
    const directory = await app("schema-free-empty-extends", {
      "nuxt.config.ts": "export default defineNuxtConfig({ extends: [], modules: ['nuxt-safe-runtime-config'] })\n",
      "package.json": '{"dependencies":{"nuxt-safe-runtime-config":"^0.3.2"}}\n',
    })
    const result = await cli([directory])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("removed nuxt-safe-runtime-config")
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).not.toContain("nuxt-safe-runtime-config")
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toEqual({ dependencies: {} })
  })
})

describe("upgradeCodemods", () => {
  const fromOtherModules = ["nuxthub", "nuxt-safe-runtime-config", "t3-env", "resend", "nuxt-cron", "nuxt-better-auth", "docus", "nuxt-content"]

  it("holds every codemod that is not a move from another module", () => {
    expect([...upgradeCodemods.map(codemod => codemod.name), ...fromOtherModules].sort()).toEqual(codemods.map(codemod => codemod.name).sort())
  })

  it("renames a former driver value in nuxt.config.ts", async () => {
    const directory = await app("upgrade-driver-value", {
      "package.json": '{"type":"module","dependencies":{"vite-hub":"0.1.0"}}\n',
      "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: ['vite-hub/nuxt'],\n  vitehub: { host: 'cloudflare', kv: { driver: 'cloudflare-kv-binding', binding: 'KV' } },\n})\n",
    })
    const migration = await runMigration({ cwd: directory, codemods: upgradeCodemods })
    expect(migration.steps.map(step => [step.codemod.name, step.detection.reason, step.error])).toEqual([
      ["driver-key", "nuxt.config.ts uses a former backend key or driver name", undefined],
    ])
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toContain("kv: { driver: 'cloudflare', binding: 'KV' }")
    expect(await detectCodemods(directory, upgradeCodemods)).toEqual([])
  })

  it.each([["default", codemods], ["upgrade", upgradeCodemods]] as const)("renames drivers in options moved by the %s registry", async (name, registry) => {
    const directory = await app(`${name}-moved-driver`, {
      "nuxt.config.ts": "export default defineNuxtConfig({ vitehub: {}, vite: { kv: { driver: 'cloudflare-kv-binding', binding: 'KV' } } })\n",
    })
    const migration = await runMigration({ cwd: directory, codemods: registry })
    expect(migration.steps.map(step => [step.codemod.name, step.error])).toEqual([["vitehub-options", undefined], ["driver-key", undefined]])
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toContain("kv: { driver: 'cloudflare', binding: 'KV' }")
  })

  it("detects a driver conflict even when it has no edit", async () => {
    const directory = await app("driver-conflict", {
      "nuxt.config.ts": "export default defineNuxtConfig({ vitehub: { queue: { provider: 'cloudflare', driver: 'cloudflare' } } })\n",
    })
    const migration = await runMigration({ cwd: directory, codemods: upgradeCodemods })
    expect(migration.edits).toEqual([])
    expect(formatMigrationReport(migration)).toContain("`queue` sets both `provider` and `driver`. Keep one `driver`.")
  })

  it("keeps a computed queue driver key static", async () => {
    const directory = await app("computed-driver-key", {
      "nuxt.config.ts": "export default defineNuxtConfig({ vitehub: { queue: { ['provider']: 'cloudflare' } } })\n",
    })
    await runMigration({ cwd: directory, codemods: upgradeCodemods })
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toContain("queue: { ['driver']: 'cloudflare' }")
  })

  it("runs the codemods that touch the same code in a working order", async () => {
    const directory = await app("upgrade-order", {
      "package.json": '{"type":"module","dependencies":{"vite-hub":"0.0.9"}}\n',
      "vite.config.ts": "import { vitehub } from 'vite-hub'\nexport default { agent: { providers: { state: { provider: 'sqlite' } } }, plugins: [vitehub({ preset: 'node' })] }\n",
      "server/api/secret.ts": "import { useServerEnv } from '#vitehub/env/server'\nimport { defineEnvSecret } from 'vite-hub/env/secret'\nexport default () => [useServerEnv(), defineEnvSecret]\n",
    })
    const migration = await runMigration({ cwd: directory, codemods: upgradeCodemods })
    expect(migration.steps.filter(step => step.error)).toEqual([])
    expect(await readFile(join(directory, "vite.config.ts"), "utf8")).toBe("import { vitehub } from 'vite-hub'\nexport default { plugins: [vitehub({\n  host: 'node',\n  agent: { providers: { state: { driver: 'sqlite' } } },\n})] }\n")
    expect(await readFile(join(directory, "server/api/secret.ts"), "utf8")).toBe("import { useServerEnv, defineEnvSecret } from 'vite-hub/env'\nexport default () => [useServerEnv(), defineEnvSecret]\n")
    expect(await detectCodemods(directory, upgradeCodemods)).toEqual([])
  })
})
