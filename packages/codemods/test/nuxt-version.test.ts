import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { subset } from "semver"
import { parse } from "yaml"

import { codemods, runCli, runMigration, upgradeCodemods } from "../src/index.ts"
import { nitroRange } from "../src/shared/nuxt-version.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
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

function withDependencies(extra: Record<string, string>): string {
  return `${JSON.stringify({ name: "shop", private: true, dependencies: { "nuxt-safe-runtime-config": "^0.3.2", ...extra } }, null, 2)}\n`
}

describe("codemods that add vite-hub/nuxt before Nuxt 4.7", () => {
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
    expect(result.stderr).toContain("package.json requires nuxt \"^4.2.0\", which allows a Nuxt version before 4.7")
    expect(result.stderr).toContain("pnpm add nuxt@^4.7.0 nitro")
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
    expect(await dependencies(directory)).toEqual({ "nuxt": "npm:nuxt-nightly@5x", "vite-hub": ">=0.5.1 <1" })
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

  it.each([
    ["one codemod", ["nuxt-safe-runtime-config"]],
    ["migration", []],
  ])("stops on a prerelease-excluding range and upgrades only with the flag: %s", async (name, args) => {
    const directory = await app(`exclusive-${name}`, { ...nuxt4App, "package.json": nuxt4App["package.json"].replace("^4.2.0", ">=4.0.0 <5.0.0") })
    const before = await snapshot(directory)
    expect(await cli([...args, directory])).toMatchObject({ code: 1, stderr: expect.stringContaining("--nuxt-nightly") })
    expect(await snapshot(directory)).toEqual(before)
    expect((await cli([...args, directory, "--nuxt-nightly"])).code).toBe(0)
    expect((await dependencies(directory)).nuxt).toBe("npm:nuxt-nightly@5x")
  })

  it.each([
    ["one codemod", ["nuxt-safe-runtime-config"]],
    ["migration", []],
  ])("removes the unused module without changing Nuxt: %s", async (name, args) => {
    for (const flags of [[], ["--nuxt-nightly"]]) {
      const directory = await app(`remove-${name}`, {
        "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n",
        "package.json": nuxt4App["package.json"],
      })
      const result = await cli([...args, directory, ...flags])
      expect(result.code).toBe(0)
      expect(result.stdout).not.toContain("npm:nuxt-nightly@5x")
      expect(await dependencies(directory)).toEqual({ nuxt: "^4.2.0" })
      expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).not.toContain("vite-hub/nuxt")
    }
  })

  it("does not upgrade Nuxt when no codemod succeeds", async () => {
    const directory = await app("failed-cron", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-cron'] })\n",
      "package.json": nuxt4App["package.json"].replace("nuxt-safe-runtime-config", "nuxt-cron"),
    })
    const before = await snapshot(directory)
    const result = await cli([directory, "--nuxt-nightly"])
    expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining("has no cron jobs") })
    expect(result.stdout).not.toContain("npm:nuxt-nightly@5x")
    expect(await snapshot(directory)).toEqual(before)
  })

  it("does not commit earlier successful edits if a later plan needs Nuxt 5", async () => {
    const directory = await app("earlier-step", nuxt4App)
    const earlier = {
      name: "earlier-step",
      description: "An independent migration.",
      usage: "[dir]",
      detect: async () => ({ reason: "Always applies" }),
      run: async () => ({
        summary: "Adds a marker file.",
        edits: [{ path: "marker.txt", before: undefined, after: "done" }],
        followUps: [],
        notes: [],
        nextSteps: [],
      }),
    }
    await expect(runMigration({ cwd: directory, codemods: [earlier, ...codemods] })).rejects.toMatchObject({ code: "CODEMODS_NUXT_UNSUPPORTED" })
    expect(await snapshot(directory)).toEqual(nuxt4App)
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
    ["catalog:", 'catalog: { nuxt: "^4.3.0" }\n', "^4.3.0"],
    ["catalog:legacy", 'catalogs: { legacy: { nuxt: "<5.0.0" } }\n', "<5.0.0"],
    ["catalog:legacy", 'catalog: &legacy { nuxt: "^4.4.0" }\ncatalogs: { legacy: *legacy }\n', "^4.4.0"],
    ["catalog:default", "catalogs:\n  default:\n    nuxt: '>=4.0.0 <5'\n", ">=4.0.0 <5"],
    ["catalog:frameworks", "packages:\n  - apps/*\ncatalog:\n  nuxt: npm:nuxt-nightly@5x\ncatalogs:\n  frameworks:\n    \"nuxt\": ~4.1.0\n  tools:\n    nuxt: ^5.0.0\n", "~4.1.0"],
    ["catalog:", "catalog:\n  nuxt: npm:nuxt-nightly@5x\ncatalogs:\n  old:\n    nuxt: ^4.2.0\n", undefined],
  ])("reads nuxt \"%s\" from pnpm-workspace.yaml", async (nuxt, workspace, stopsFor) => {
    const directory = await app(`catalog-${encodeURIComponent(nuxt)}-${stopsFor ?? "5"}`, {
      "pnpm-workspace.yaml": workspace,
      "apps/web/.env.example": nuxt4App[".env.example"],
      "apps/web/nuxt.config.ts": nuxt4App["nuxt.config.ts"],
      "apps/web/package.json": `${JSON.stringify({ dependencies: { nuxt, "nuxt-safe-runtime-config": "^0.3.2" } })}\n`,
    })
    const migration = runMigration({ cwd: join(directory, "apps/web"), dryRun: true })
    if (!stopsFor) return expect(migration).resolves.toMatchObject({ notes: [] })
    await expect(migration).rejects.toMatchObject({ code: "CODEMODS_NUXT_UNSUPPORTED", message: expect.stringContaining(`package.json requires nuxt "${nuxt}", which pnpm-workspace.yaml sets to "${stopsFor}"`) })
  })

  it.each([
    ["^4.6.0", true],
    ["~4.6.4", true],
    ["4.7.0-rc.1", true],
    ["^3 || ^4.7.0", true],
    ["<5", true],
    ["<5.0.0", true],
    [">=5.0.0-beta.1 <5.0.0", false],
    ["<=3", true],
    [">=3 <5", true],
    ["^3 || ^5", true],
    [">=3", true],
    ["^4.6.0 || ^5.0.0", true],
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

  it("marks plans from codemods that add vite-hub/nuxt", async () => {
    const adds: string[] = []
    const marked: string[] = []
    for (const codemod of codemods) {
      const directory = join(packageRoot, "src", codemod.name)
      const sources = await readdir(directory, { recursive: true })
      const code = await Promise.all(sources.filter(file => file.endsWith(".ts")).map(file => readFile(join(directory, file), "utf8")))
      if (code.some(source => source.includes("useViteHubModule("))) adds.push(codemod.name)
      if (code.some(source => source.includes("requiresNitro3: true"))) marked.push(codemod.name)
    }
    expect(adds).toHaveLength(7)
    expect(marked).toEqual(adds)
  })
})

describe("codemods that add vite-hub/nuxt on Nuxt 4.7", () => {
  it.each([
    ["one codemod", ["nuxt-safe-runtime-config"], []],
    ["migration", [], []],
    ["migration with --nuxt-nightly", [], ["--nuxt-nightly"]],
  ])("adds nitro without changing Nuxt: %s", async (name, args, flags) => {
    const directory = await app(`nitro-${name.replaceAll(/\W+/g, "-")}`, { ...nuxt4App, "package.json": withDependencies({ nuxt: "^4.7.0" }) })
    const result = await cli([...args, directory, ...flags])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(await dependencies(directory)).toEqual({ "nitro": nitroRange, "nuxt": "^4.7.0", "vite-hub": ">=0.5.1 <1" })
    expect(result.stdout).toContain(`package.json now lists nitro "${nitroRange}" in dependencies.`)
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toContain("'vite-hub/nuxt'")
  })

  it("shows the nitro line in a dry run and writes nothing", async () => {
    const directory = await app("nitro-dry-run", { ...nuxt4App, "package.json": withDependencies({ nuxt: "^4.7.0" }) })
    const before = await snapshot(directory)
    const result = await cli(["nuxt-safe-runtime-config", directory, "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`+    "nitro": "${nitroRange}",`)
    expect(await snapshot(directory)).toEqual(before)
  })

  it.each([
    ["dependencies", { nuxt: "^4.7.0", nitro: "^3.0.261103-rc" }],
    ["dependencies", { nuxt: "^4.7.0", nitro: "3.0.261103-rc || ^3.0.261103" }],
    ["devDependencies", { nuxt: "~4.7.2" }],
  ])("leaves nitro and Nuxt as they are when %s list nitro", async (section, extra) => {
    const manifest = JSON.parse(withDependencies(extra))
    if (section === "devDependencies") manifest.devDependencies = { nitro: "3.0.261103-rc" }
    const directory = await app(`nitro-listed-${section}`, { ...nuxt4App, "package.json": `${JSON.stringify(manifest, null, 2)}\n` })
    const migration = await runMigration({ cwd: directory })
    expect(migration.notes.join("\n")).not.toContain("nitro")
    const written = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
    expect(written.dependencies).toMatchObject(extra)
    expect(written.devDependencies).toEqual(manifest.devDependencies)
  })

  it.each([">=4.7.0 <6", "^4.7.0 || ^5.0.0", ">=4.7.0"])("adds nitro when %s allows Nuxt 4.7 next to Nuxt 5", async (nuxt) => {
    const directory = await app(`nitro-range-${encodeURIComponent(nuxt)}`, { ...nuxt4App, "package.json": withDependencies({ nuxt }) })
    const migration = await runMigration({ cwd: directory, dryRun: true })
    const manifest = JSON.parse(migration.edits.find(edit => edit.path === "package.json")?.after ?? "{}")
    expect(manifest.dependencies).toMatchObject({ nitro: nitroRange, nuxt })
  })

  it.each([
    ["2.2.28", "dependencies"],
    ["3.0.261102-rc", "dependencies"],
    ["3.0.261104-rc", "dependencies"],
    ["^3.0.261103-rc || 3.0.261104-rc", "devDependencies"],
    ["^3.0.0", "devDependencies"],
    ["npm:nitro-nightly@latest", "dependencies"],
  ])("replaces nitro \"%s\" in %s, which Nuxt 4.7 cannot build with", async (nitro, section) => {
    for (const args of [["nuxt-safe-runtime-config"], []]) {
      const manifest = JSON.parse(withDependencies({ nuxt: "4.7.0" }))
      if (section === "dependencies") manifest.dependencies.nitro = nitro
      else manifest.devDependencies = { nitro }
      const directory = await app(`nitro-old-${encodeURIComponent(nitro)}-${args.length}`, { ...nuxt4App, "package.json": `${JSON.stringify(manifest, null, 2)}\n` })
      const result = await cli([...args, directory])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`package.json listed nitro "${nitro}"`)
      const written = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
      expect(written[section].nitro).toBe(nitroRange)
      expect(section === "dependencies" ? written.devDependencies : written.dependencies.nitro).toBeUndefined()
    }
  })

  it.each([
    ["^2.12.0", nitroRange],
    ["3.0.261103-rc", "catalog:"],
  ])("reads nitro from a pnpm catalog that sets %s", async (catalogNitro, expected) => {
    const directory = await app(`nitro-catalog-${encodeURIComponent(catalogNitro)}`, {
      "pnpm-workspace.yaml": `catalog:\n  nitro: ${catalogNitro}\n`,
      "apps/web/.env.example": nuxt4App[".env.example"],
      "apps/web/nuxt.config.ts": nuxt4App["nuxt.config.ts"],
      "apps/web/package.json": withDependencies({ nuxt: "^4.7.0", nitro: "catalog:" }),
    })
    const web = join(directory, "apps/web")
    expect((await cli([web])).code).toBe(0)
    expect((await dependencies(web)).nitro).toBe(expected)
  })

  it("adds nitro to the app when a pnpm catalog sets Nuxt 4.7", async () => {
    const directory = await app("nitro-catalog", {
      "pnpm-workspace.yaml": "catalog:\n  nuxt: ^4.7.0\n",
      "apps/web/.env.example": nuxt4App[".env.example"],
      "apps/web/nuxt.config.ts": nuxt4App["nuxt.config.ts"],
      "apps/web/package.json": withDependencies({ nuxt: "catalog:" }),
    })
    const web = join(directory, "apps/web")
    expect((await cli([web])).code).toBe(0)
    expect(await dependencies(web)).toMatchObject({ nitro: nitroRange, nuxt: "catalog:" })
    expect(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8")).toBe("catalog:\n  nuxt: ^4.7.0\n")
  })

  it("adds no nitro to an app that the codemods only clean up", async () => {
    const directory = await app("nitro-remove", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })\n",
      "package.json": withDependencies({ nuxt: "^4.7.0" }),
    })
    expect((await cli([directory])).code).toBe(0)
    expect(await dependencies(directory)).toEqual({ nuxt: "^4.7.0" })
  })

  it("adds a nitro range that vite-hub accepts", async () => {
    const workspace = parse(await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"))
    const viteHub = JSON.parse(await readFile(join(repositoryRoot, "packages/vite-hub/package.json"), "utf8"))
    const peer: string = viteHub.peerDependencies.nitro
    const accepted: string = peer.startsWith("catalog:") ? workspace.catalogs[peer.slice("catalog:".length)].nitro : peer
    expect(subset(nitroRange, accepted, { includePrerelease: true })).toBe(true)
  })
})
