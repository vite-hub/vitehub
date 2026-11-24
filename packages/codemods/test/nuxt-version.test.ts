import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { codemods, runCli, runMigration, upgradeCodemods } from "../src/index.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const scratch = join(packageRoot, ".tmp/nuxt-version-test")

const nuxt4App = {
  ".env.example": "# @public @type=url\nNUXT_PUBLIC_API_BASE=https://api.example.com\n",
  "nuxt.config.ts": "export default defineNuxtConfig({\n  modules: ['nuxt-safe-runtime-config'],\n  safeRuntimeConfig: { envSchema: '.env.example' },\n})\n",
  "package.json": `${JSON.stringify({ name: "shop", private: true, dependencies: { "nuxt": "^4.2.0", "nuxt-safe-runtime-config": "^0.3.2" } }, null, 2)}\n`,
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

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[relative(directory, path)] = await readFile(path, "utf8")
  }
  return files
}

async function cli(args: string[]) {
  let stdout = ""
  let stderr = ""
  const code = await runCli(args, { stdout: text => stdout += text, stderr: text => stderr += text })
  return { code, stdout, stderr }
}

async function dependencies(directory: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8")).dependencies
}

afterAll(() => rm(scratch, { recursive: true, force: true }))

describe("codemods that add vite-hub/nuxt on Nuxt 4", () => {
  it.each([
    ["one codemod", ["nuxt-safe-runtime-config"]],
    ["one codemod, dry run", ["nuxt-safe-runtime-config", "--dry-run"]],
    ["migration", []],
    ["migration, dry run", ["--dry-run"]],
  ])("stops and writes nothing: %s", async (name, args) => {
    const directory = await app(`stop-${name.replaceAll(/\W+/g, "-")}`, nuxt4App)
    const before = await snapshot(directory)
    const [first, ...rest] = args
    const result = await cli(first && !first.startsWith("-") ? [first, directory, ...rest] : [directory, ...args])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("package.json requires nuxt \"^4.2.0\"")
    expect(result.stderr).toContain("--nuxt-nightly")
    expect(await snapshot(directory)).toEqual(before)
  })

  it.each([
    ["one codemod", ["nuxt-safe-runtime-config"]],
    ["migration", []],
  ])("sets Nuxt 5 nightly and migrates with --nuxt-nightly: %s", async (name, args) => {
    const directory = await app(`nightly-${name.replaceAll(/\W+/g, "-")}`, nuxt4App)
    const result = await cli([...args, directory, "--nuxt-nightly"])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(await dependencies(directory)).toEqual({ "@vite-hub/env": expect.any(String), "nuxt": "npm:nuxt-nightly@5x", "vite-hub": expect.any(String) })
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toContain("'vite-hub/nuxt'")
    expect(result.stdout).toContain("npm:nuxt-nightly@5x")
  })

  it("writes nothing with --nuxt-nightly and --dry-run, and shows the Nuxt change", async () => {
    const directory = await app("nightly-dry-run", nuxt4App)
    const before = await snapshot(directory)
    const result = await cli([directory, "--nuxt-nightly", "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("+    \"nuxt\": \"npm:nuxt-nightly@5x\",")
    expect(await snapshot(directory)).toEqual(before)
  })

  it("reads a pnpm catalog and replaces it with Nuxt 5 nightly", async () => {
    const files = {
      "pnpm-workspace.yaml": "catalog:\n  nuxt: ^4.2.0\n",
      "apps/web/.env.example": nuxt4App[".env.example"],
      "apps/web/nuxt.config.ts": nuxt4App["nuxt.config.ts"],
      "apps/web/package.json": `${JSON.stringify({ dependencies: { "nuxt": "catalog:", "nuxt-safe-runtime-config": "^0.3.2" } }, null, 2)}\n`,
    }
    const directory = await app("catalog", files)
    const web = join(directory, "apps/web")
    const before = await snapshot(directory)
    const stopped = await cli([web])
    expect(stopped.code).toBe(1)
    expect(stopped.stderr).toContain("package.json requires nuxt \"catalog:\", which pnpm-workspace.yaml sets to \"^4.2.0\"")
    expect(await snapshot(directory)).toEqual(before)
    expect((await cli([web, "--nuxt-nightly"])).code).toBe(0)
    expect((await dependencies(web)).nuxt).toBe("npm:nuxt-nightly@5x")
  })

  it.each([
    ["catalog:", "catalog:\n  vue: ^3.5.0\n  nuxt: ^4.2.0 # pinned\n", "^4.2.0"],
    ["catalog:default", "catalogs:\n  default:\n    nuxt: '>=4.0.0 <5'\n", ">=4.0.0 <5"],
    ["catalog:frameworks", "packages:\n  - apps/*\ncatalog:\n  nuxt: npm:nuxt-nightly@5x\ncatalogs:\n  frameworks:\n    \"nuxt\": ~4.1.0\n  tools:\n    nuxt: ^5.0.0\n", "~4.1.0"],
    ["catalog:", "catalog:\n  nuxt: npm:nuxt-nightly@5x\ncatalogs:\n  old:\n    nuxt: ^4.2.0\n", undefined],
  ])("reads nuxt \"%s\" from pnpm-workspace.yaml", async (nuxt, workspace, stopsFor) => {
    const directory = await app(`catalog-${encodeURIComponent(nuxt)}-${stopsFor ?? "5"}`, {
      "pnpm-workspace.yaml": workspace,
      "apps/web/nuxt.config.ts": nuxt4App["nuxt.config.ts"],
      "apps/web/package.json": `${JSON.stringify({ dependencies: { nuxt, "nuxt-safe-runtime-config": "^0.3.2" } })}\n`,
    })
    const migration = runMigration({ cwd: join(directory, "apps/web"), dryRun: true })
    if (!stopsFor) return expect(migration).resolves.toMatchObject({ notes: [] })
    await expect(migration).rejects.toMatchObject({ code: "CODEMODS_NUXT_UNSUPPORTED", message: expect.stringContaining(`package.json requires nuxt "${nuxt}", which pnpm-workspace.yaml sets to "${stopsFor}"`) })
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
  ])("checks the allowed Nuxt versions in %s", async (nuxt, stops) => {
    const directory = await app(`range-${encodeURIComponent(nuxt)}`, {
      ...nuxt4App,
      "package.json": `${JSON.stringify({ dependencies: { nuxt, "nuxt-safe-runtime-config": "^0.3.2" } })}\n`,
    })
    const migration = runMigration({ cwd: directory, dryRun: true })
    if (!stops) return expect(migration).resolves.toMatchObject({ notes: [] })
    await expect(migration).rejects.toMatchObject({ code: "CODEMODS_NUXT_UNSUPPORTED", message: expect.stringContaining(`package.json requires nuxt "${nuxt}"`) })
  })

  it("leaves a Nuxt 5 app on its version with --nuxt-nightly", async () => {
    const directory = await app("nuxt-5", { ...nuxt4App, "package.json": nuxt4App["package.json"].replace("^4.2.0", "^5.0.0") })
    expect((await cli([directory, "--nuxt-nightly"])).code).toBe(0)
    expect((await dependencies(directory)).nuxt).toBe("^5.0.0")
  })

  it("does not stop the upgrade codemods, which do not add vite-hub/nuxt", async () => {
    const directory = await app("upgrade", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['vite-hub/nuxt'], vitehub: { kv: true } })\n",
      "package.json": `${JSON.stringify({ dependencies: { "nuxt": "^4.2.0", "vite-hub": "^0.4.0" } })}\n`,
    })
    await expect(runMigration({ cwd: directory, dryRun: true, codemods: upgradeCodemods })).resolves.toMatchObject({ cwd: directory })
  })

  it("marks every codemod that adds vite-hub/nuxt", async () => {
    const adds: string[] = []
    for (const codemod of codemods) {
      const directory = join(packageRoot, "src", codemod.name)
      const sources = await readdir(directory, { recursive: true })
      for (const file of sources.filter(file => file.endsWith(".ts"))) {
        if ((await readFile(join(directory, file), "utf8")).includes("useViteHubModule(")) {
          adds.push(codemod.name)
          break
        }
      }
    }
    expect(adds).toHaveLength(7)
    expect(codemods.filter(codemod => codemod.requiresNuxt5).map(codemod => codemod.name)).toEqual(adds)
  })
})
