import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

import { createProject, fakePackageManager, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupAddPlan, SetupError, SetupRemovePlan, SetupStatus } from "../src/setup/index.ts"

type RemoveResult = SetupRemovePlan & { error?: SetupError, impliedBy?: string[], rerun?: string, snippet?: string }

function remove(args: string[], root: string, spawn?: ViteHubCliSpawn) {
  return runSetup<RemoveResult>(["remove", ...args, "--json"], root, {}, { spawn })
}

function add(args: string[], root: string, spawn?: ViteHubCliSpawn) {
  return runSetup<SetupAddPlan & { error?: SetupError }>(["add", ...args, "--yes", "--json"], root, {}, { spawn })
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return Object.fromEntries(await Promise.all(files.map(async file => [relative(root, file), await readFile(file, "utf8")] as const)))
}

async function enabled(root: string, id: string): Promise<string | undefined> {
  return (await runSetup<SetupStatus>(["status", "--json"], root)).json.features.find(item => item.id === id)?.enabled
}

describe("vitehub remove", () => {
  it.each([
    { feature: "kv", dependent: "cache", options: 'kv: true, cache: { driver: "kv" }' },
    { feature: "console", dependent: "connections", options: 'console: { auth: false }, connections: { management: true }' },
    { feature: "env", dependent: "observability", options: 'env: true, observability: { posthog: true }' },
    { feature: "agent", dependent: "observability", options: 'agent: true, console: { auth: false }, observability: { papercuts: true }' },
    { feature: "console", dependent: "observability", options: 'agent: true, console: { auth: false }, observability: { papercuts: true }' },
    { feature: "database", dependent: "agent", options: 'database: true, agent: { invocations: "database" }' },
    { feature: "database", dependent: "agent", options: 'database: true, agent: { invocations: { store: "database" } }' },
  ])("refuses to remove $feature while $dependent requires it ($options)", async ({ feature, dependent, options }) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node", ${options} }`) })
    const before = await snapshot(root)
    for (const flags of [[], ["--force"]]) {
      const refused = await remove([feature, "--yes", ...flags], root)
      expect(refused.exitCode, refused.stdout).toBe(3)
      expect(refused.json.error).toMatchObject({ code: "SETUP_FEATURE_REQUIRED" })
      expect(await snapshot(root)).toEqual(before)
    }
    const together = await remove([feature, dependent, "--dry-run", "--force"], root)
    expect(together.exitCode, together.stdout).toBe(0)
  })

  it.each([
    { config: 'rootDir: "app",', file: "app/server/schedules/hello.ts" },
    { config: 'serverDir: "backend",', file: "backend/schedules/hello.ts" },
  ])("removes a starter from the configured Nuxt directory ($config)", async ({ config, file }) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "nuxt.config.ts": `export default defineNuxtConfig({ ${config} modules: [["vite-hub/nuxt", { preset: "node" }]] })\n`,
    })
    const pm = fakePackageManager(root)
    const added = await add(["schedule", "--name", "hello", "--option", "schedule.runtime.driver=process"], root, pm.spawn)
    expect(added.exitCode, added.stdout).toBe(0)
    expect(existsSync(join(root, file))).toBe(true)
    const forced = await remove(["schedule", "--force", "--dry-run"], root)
    expect(forced.json.changes).toContainEqual(expect.objectContaining({ kind: "delete", path: file }))
    const removed = await remove(["schedule", "--yes"], root, pm.spawn)
    expect(removed.exitCode, removed.stdout).toBe(0)
    expect(existsSync(join(root, file))).toBe(false)
  })

  it("gives back the original bytes after add with a starter and an install", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare" }`) })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)

    const added = await add(["schedule", "--name", "nightly"], root, pm.spawn)
    expect(added.exitCode, JSON.stringify(added.json.error)).toBe(0)
    expect(existsSync(join(root, "server/schedules/nightly.ts"))).toBe(true)

    const { exitCode, json, loadConfig } = await remove(["schedule", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(loadConfig).not.toHaveBeenCalled()
    expect(json).toMatchObject({ features: ["schedule"], status: "applied", turnedOff: ["schedule"], uninstall: { command: "pnpm remove @vite-hub/schedule", packages: ["@vite-hub/schedule"] } })
    expect(json.changes.map(change => [change.kind, change.path])).toEqual([["patch", "vite.config.ts"], ["delete", "server/schedules/nightly.ts"]])
    expect(pm.calls.at(-1)).toEqual(["pnpm", "remove", "@vite-hub/schedule"])
    expect(await snapshot(root)).toEqual(original)
    expect(existsSync(join(root, "server"))).toBe(false)
  })

  it("uninstalls an unused runtime package declared in devDependencies", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ devDependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ preset: "cloudflare", realtime: true }`),
    })
    const pm = fakePackageManager(root)

    const { exitCode, json } = await remove(["realtime", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.uninstall).toEqual({ command: "pnpm remove @vite-hub/realtime", devPackages: [], packages: ["@vite-hub/realtime"] })
    expect(pm.calls).toEqual([["pnpm", "remove", "@vite-hub/realtime"]])
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({ name: "app", packageManager: "pnpm@10.0.0" })
  })

  it("turns off features that only the removed feature implied and uninstalls their packages", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare" }`) })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)
    expect((await add(["comments"], root, pm.spawn)).exitCode).toBe(0)
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({ dependencies: { "@vite-hub/comments": "1.0.0", "@vite-hub/database": "1.0.0" }, devDependencies: { "drizzle-kit": "1.0.0" } })

    const { exitCode, json } = await remove(["comments", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.turnedOff).toEqual(["comments", "database"])
    expect(json.uninstall).toEqual({ command: "pnpm remove @vite-hub/comments @vite-hub/database drizzle-orm drizzle-kit", devPackages: ["drizzle-kit"], packages: ["@vite-hub/comments", "@vite-hub/database", "drizzle-orm"] })
    expect(await snapshot(root)).toEqual(original)
  })

  it("keeps the packages that another enabled feature declares", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/database": "1.0.0", "drizzle-orm": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ preset: "cloudflare", database: true, connections: true }`),
    })

    const { exitCode, json } = await remove(["connections", "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ status: "planned", turnedOff: ["connections"], uninstall: { devPackages: [], packages: [] } })
  })

  it("keeps an edited starter and refuses until --force", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare" }`) })
    expect((await add(["queue", "--name", "welcome", "--no-install"], root)).exitCode).toBe(0)
    expect((await add(["queue", "--name", "digest", "--no-install"], root)).exitCode).toBe(0)
    const edited = `${await readFile(join(root, "server/queues/welcome.ts"), "utf8")}// sends the welcome email\n`
    await writeFile(join(root, "server/queues/welcome.ts"), edited)
    const config = await readFile(join(root, "vite.config.ts"), "utf8")

    const refused = await remove(["queue", "--yes", "--no-uninstall"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error).toMatchObject({ code: "SETUP_FEATURE_IN_USE" })
    expect(refused.json.error?.why).toContain("server/queues/welcome.ts")
    expect(refused.json.references).toEqual([{ feature: "queue", file: "server/queues/welcome.ts" }])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(config)
    expect(existsSync(join(root, "server/queues/digest.ts"))).toBe(true)

    const forced = await remove(["queue", "--yes", "--no-uninstall", "--force"], root)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.kept).toEqual([{ path: "server/queues/welcome.ts", reason: "edited" }])
    expect(forced.json.changes.map(change => change.path)).toEqual(["vite.config.ts", "server/queues/digest.ts"])
    expect(await readFile(join(root, "server/queues/welcome.ts"), "utf8")).toBe(edited)
    expect(existsSync(join(root, "server/queues/digest.ts"))).toBe(false)
    expect(forced.json.nextSteps.join("\n")).toContain("server/queues/welcome.ts stayed because it differs from the starter")
  })

  it("keeps every starter with --keep-files", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare" }`) })
    expect((await add(["workflow", "--name", "onboard", "--no-install"], root)).exitCode).toBe(0)

    const { exitCode, json } = await remove(["workflow", "--yes", "--keep-files", "--no-uninstall"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.kept).toEqual([{ path: "server/workflows/onboard.ts", reason: "keep-files" }])
    expect(json.changes.map(change => change.kind)).toEqual(["patch"])
    expect(existsSync(join(root, "server/workflows/onboard.ts"))).toBe(true)
  })

  it("refuses a feature that another enabled feature implies, and writes false with --force", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare", agent: true, workflow: true }`) })
    const before = await readFile(join(root, "vite.config.ts"), "utf8")

    const refused = await remove(["workflow", "--yes", "--no-uninstall"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error).toMatchObject({ code: "SETUP_FEATURE_IMPLIED", message: "workflow stays on because agent turns it on." })
    expect(refused.json.impliedBy).toEqual(["agent"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)

    const forced = await remove(["workflow", "--yes", "--no-uninstall", "--force"], root)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ preset: "cloudflare", agent: true, workflow: false }`))
    expect(await enabled(root, "workflow")).toBe("off")
  })

  it("does not treat the Console as a Database consumer", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare", console: true, database: true }`) })

    const { exitCode, json } = await remove(["database", "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(json.turnedOff).toEqual(["database"])
  })

  it("refuses while app code imports the feature, with file and line", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "server/api/doc.get.ts": `import { defineHandler } from "nitro/h3"\n\nimport { useRealtime } from "vite-hub/realtime"\n\nexport default defineHandler(() => useRealtime("docs"))\n`,
      "src/client.ts": `export const load = () => import("@vite-hub/realtime/client")\n`,
      "vite.config.ts": viteConfig(`{ preset: "cloudflare", realtime: true }`),
    })

    const refused = await remove(["realtime", "--yes"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_IN_USE")
    expect(refused.json.references).toEqual([
      { feature: "realtime", file: "server/api/doc.get.ts", line: 3, module: "vite-hub/realtime" },
      { feature: "realtime", file: "src/client.ts", line: 1, module: "@vite-hub/realtime/client" },
    ])

    const forced = await remove(["realtime", "--yes", "--force"], root)

    // The app still imports the package, so it stays installed.
    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(forced.json.references).toHaveLength(2)
  })

  it.each([
    { file: "src/App.svelte", content: '<script>\nimport { connect } from "vite-hub/realtime/client"\n</script>\n' },
    { file: "src/page.astro", content: '---\nimport { connect } from "vite-hub/realtime/client"\n---\n' },
    { file: "src/page.mdx", content: 'import { connect } from "vite-hub/realtime/client"\n' },
    { file: "src/page.md", content: 'import { connect } from "vite-hub/realtime/client"\n' },
    { file: "index.html", content: '<script type="module">\nimport { connect } from "vite-hub/realtime/client"\n</script>\n' },
  ])("preserves the feature and owner package used in $file", async ({ file, content }) => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      [file]: content,
      "vite.config.ts": viteConfig(`{ preset: "cloudflare", realtime: true }`),
    })
    const before = await snapshot(root)
    const pm = fakePackageManager(root)

    const refused = await remove(["realtime", "--yes"], root, pm.spawn)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_IN_USE")
    expect(refused.json.references).toEqual([{ feature: "realtime", file, line: content.startsWith("import") ? 1 : 2, module: "vite-hub/realtime/client" }])
    expect(await snapshot(root)).toEqual(before)
    expect(pm.calls).toEqual([])

    const forced = await remove(["realtime", "--yes", "--force"], root, pm.spawn)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(forced.json.references).toEqual(refused.json.references)
    expect(pm.calls).toEqual([])
    expect(await readFile(join(root, file), "utf8")).toBe(content)
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({ dependencies: { "@vite-hub/realtime": "1.0.0" } })
  })

  it.each(["vite-hub/realtime", "vite-hub/realtime/client"])("keeps the owner package when only a retained facade imports it: %s", async (specifier) => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "src/client.ts": `export const load = () => import(${JSON.stringify(specifier)})\n`,
      "vite.config.ts": viteConfig(`{ preset: "cloudflare", realtime: true }`),
    })
    const pm = fakePackageManager(root)

    const forced = await remove(["realtime", "--yes", "--force"], root, pm.spawn)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(forced.json.references).toEqual([{ feature: "realtime", file: "src/client.ts", line: 1, module: specifier }])
    expect(pm.calls).toEqual([])
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({ dependencies: { "@vite-hub/realtime": "1.0.0" } })
  })

  it("keeps the owner package imported by an edited starter after forced removal", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "cloudflare" }`) })
    const pm = fakePackageManager(root)
    expect((await add(["schedule", "--name", "nightly"], root, pm.spawn)).exitCode).toBe(0)
    const file = join(root, "server/schedules/nightly.ts")
    const edited = `${await readFile(file, "utf8")}// Keep this schedule.\n`
    await writeFile(file, edited)

    const forced = await remove(["schedule", "--yes", "--force"], root, pm.spawn)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(pm.calls).toEqual([["pnpm", "add", "@vite-hub/schedule"]])
    expect(await readFile(file, "utf8")).toBe(edited)
  })

  it("writes false for a feature that is on by default", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node" }`) })

    const { exitCode, json } = await remove(["env", "--yes"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.turnedOff).toEqual(["env"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ preset: "node", env: false }`))
    expect((await remove(["env", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("writes false for a feature that a discovered file turns on, only with --force", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "server/comments.ts": "export default {}\n",
      "vite.config.ts": viteConfig(`{ preset: "node", comments: true }`),
    })

    const refused = await remove(["comments", "--dry-run"], root)
    expect(refused.exitCode).toBe(3)
    expect(refused.json.references).toEqual([{ feature: "comments", file: "server/comments.ts" }])

    const forced = await remove(["comments", "--yes", "--force", "--no-uninstall"], root)
    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.kept).toEqual([])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ preset: "node", comments: false }`))
  })

  it("plans in a dry run and asks for --yes without a terminal, writing nothing", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "vercel", kv: true }`) })
    const before = await snapshot(root)

    const dry = await remove(["kv", "--dry-run"], root)
    expect(dry.exitCode).toBe(0)
    expect(dry.json).toMatchObject({ host: { name: "vercel", source: "config" }, status: "planned" })
    expect(dry.json.changes[0]!.diff).toMatch(/^-.*kv: true/mu)

    const unconfirmed = await remove(["kv", "--no-uninstall"], root)
    expect(unconfirmed.exitCode).toBe(2)
    expect(unconfirmed.json.rerun).toBe("vitehub remove kv --no-uninstall --yes --json")
    expect(await snapshot(root)).toEqual(before)

    const human = await runSetup(["remove", "kv", "--dry-run"], root)
    expect(human.stdout).toContain("-  plugins: [vitehub({ preset: \"vercel\", kv: true })],")
    expect(await snapshot(root)).toEqual(before)
  })

  it("lists the uninstall command in nextSteps with --no-uninstall and mentions host resources", async () => {
    const root = await createProject({
      ".vitehub/data/kv/key": "value",
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ preset: "cloudflare", kv: true, realtime: true }`),
    })

    const { exitCode, json } = await remove(["kv", "realtime", "--yes", "--no-uninstall"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ preset: "cloudflare" }`))
    expect(json.nextSteps).toContain("Uninstall the packages: pnpm remove @vite-hub/realtime")
    expect(json.nextSteps.join("\n")).toContain("ViteHub does not delete host resources.")
    expect(json.nextSteps.join("\n")).toContain("Local data in .vitehub/data stays.")
    expect(await readFile(join(root, ".vitehub/data/kv/key"), "utf8")).toBe("value")
  })

  it("is unchanged for a feature that is already off", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node", kv: false }`) })

    const { exitCode, json } = await remove(["kv"], root)

    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ changes: [], status: "unchanged", turnedOff: [] })
  })

  it("returns the snippet to paste for an expression", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ preset: "node", kv: process.env.KV ? true : false }`) })

    const { exitCode, json } = await remove(["kv", "--yes"], root)

    expect(exitCode).toBe(3)
    expect(json.error?.code).toBe("SETUP_CONFIG_MANUAL")
    expect(json.snippet).toBe("kv: false,")
  })

  it("rejects an unknown flag and an unknown feature", async () => {
    const root = await createProject({ "package.json": pnpmManifest })
    expect((await remove(["kv", "--purge"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await remove(["nope"], root)).json.error?.message).toContain("Unknown feature")
    expect((await remove([], root)).exitCode).toBe(2)
  })
})
