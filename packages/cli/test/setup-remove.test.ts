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
  it("gives back the original bytes after add with a starter and an install", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
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

  it.each([
    ['rootDir: "app"', "app/server"],
    ['serverDir: "backend"', "backend"],
    ['rootDir: "app", serverDir: "backend"', "app/backend"],
  ])("removes Nuxt starters from the application server directory: %s", async (options, serverDir) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${options}, vitehub: { host: "node" } })`,
    })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)
    const added = await add(["queue", "database", "--name", "jobs"], root, pm.spawn)
    expect(added.exitCode, JSON.stringify(added.json.error)).toBe(0)

    const { exitCode, json } = await remove(["queue", "database", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.references).toEqual([])
    expect(json.changes.filter(change => change.kind === "delete").map(change => change.path)).toEqual([
      `${serverDir}/databases/jobs.ts`,
      `${serverDir}/queues/jobs.ts`,
    ])
    expect(await snapshot(root)).toEqual(original)
    expect(existsSync(join(root, serverDir))).toBe(false)
  })

  it.each([
    ['srcDir: "app"', "app/server/comments.ts", "comments"],
    ['extends: ["./base"]', "base/server/comments.ts", "comments"],
    ["", "layers/base/server/comments.ts", "comments"],
    ["serverDir: process.env.SERVER_DIR", "backend/comments.ts", "comments"],
    ['srcDir: "app"', "app/server/schedules/nightly.ts", "schedule"],
  ])("requires --force when Nuxt Definition directories are unresolved: %s (%s)", async (options, path, feature) => {
    const content = feature === "comments" ? "export const comments = defineComments()\n" : "export default defineSchedule({})\n"
    const root = await createProject({
      [path]: content,
      "package.json": JSON.stringify({ dependencies: { [`@vite-hub/${feature}`]: "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${options ? `${options}, ` : ""}vitehub: { host: "node", ${feature}: true } })`,
    })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)

    const refused = await remove([feature, "--yes"], root, pm.spawn)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_SERVER_DIR_MANUAL")
    expect(refused.json.error?.fix).toContain("--force")
    expect(await snapshot(root)).toEqual(original)
    expect(pm.calls).toEqual([])

    const forced = await remove([feature, "--yes", "--force"], root, pm.spawn)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.changes.map(change => change.kind)).toEqual(["patch"])
    expect(await readFile(join(root, path), "utf8")).toBe(content)
    expect(await readFile(join(root, "nuxt.config.ts"), "utf8")).not.toContain(`${feature}: true`)
  })

  it("turns off features that only the removed feature implied and uninstalls their packages", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
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

  it.each(["observability.posthog=true", "observability.posthog.apiKey=key"])("round-trips Observability with %s", async (option) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)
    const added = await add(["observability", "--option", "observability.service=api", "--option", option], root, pm.spawn)
    expect(added.exitCode, JSON.stringify(added.json.error)).toBe(0)
    expect(added.json.install.packages).toContain("posthog-node")

    const { exitCode, json } = await remove(["observability", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.uninstall.packages).toContain("posthog-node")
    expect(pm.calls.at(-1)).toEqual(["pnpm", "remove", ...json.uninstall.packages])
    expect(await snapshot(root)).toEqual(original)
  })

  it("keeps PostHog installed when retained source imports it", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const pm = fakePackageManager(root)
    expect((await add(["observability", "--option", "observability.service=api", "--option", "observability.posthog.apiKey=key"], root, pm.spawn)).exitCode).toBe(0)
    const source = 'import { PostHog } from "posthog-node"\nexport const client = new PostHog("key")\n'
    await writeFile(join(root, "posthog.ts"), source)
    const original = await snapshot(root)
    const callsBefore = pm.calls.length

    const refused = await remove(["observability", "--yes"], root, pm.spawn)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_IN_USE")
    expect(refused.json.references).toContainEqual({ feature: "observability", file: "posthog.ts", line: 1, module: "posthog-node" })
    expect(await snapshot(root)).toEqual(original)
    expect(pm.calls).toHaveLength(callsBefore)

    const forced = await remove(["observability", "--force", "--yes"], root, pm.spawn)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall.packages).not.toContain("posthog-node")
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({ dependencies: { "posthog-node": "1.0.0" } })
    expect(await readFile(join(root, "posthog.ts"), "utf8")).toBe(source)
  })

  it.each([
    { layout: 'serverDir: "backend"', directory: "backend" },
    { layout: 'rootDir: "app"', directory: "app/server" },
    { layout: 'rootDir: "app", serverDir: "backend"', directory: "app/backend" },
  ])("removes the starter from the configured Nuxt server directory: $layout", async ({ layout, directory }) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "nuxt.config.ts": `export default defineNuxtConfig({ ${layout}, modules: [["vite-hub/nuxt", { host: "cloudflare" }]] })\n`,
    })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)
    const path = `${directory}/schedules/nightly.ts`
    expect((await add(["schedule", "--name", "nightly"], root, pm.spawn)).exitCode).toBe(0)
    expect(existsSync(join(root, path))).toBe(true)

    const { exitCode, json } = await remove(["schedule", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.changes).toContainEqual(expect.objectContaining({ kind: "delete", path }))
    expect(existsSync(join(root, path))).toBe(false)
    expect(await snapshot(root)).toEqual(original)
  })

  it("keeps files and packages when disabling an unknown feature", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node" }') })
    const pm = fakePackageManager(root)
    expect((await add(["queue", "--name", "welcome"], root, pm.spawn)).exitCode).toBe(0)
    await writeFile(join(root, "vite.config.ts"), viteConfig('{ ...shared, host: "node" }'))
    const path = "server/queues/welcome.ts"
    const content = await readFile(join(root, path), "utf8")
    const manifest = await readFile(join(root, "package.json"), "utf8")
    const calls = [...pm.calls]
    expect(await enabled(root, "queue")).toBe("unknown")

    const { exitCode, json } = await remove(["queue", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(await enabled(root, "queue")).toBe("off")
    expect(json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(await readFile(join(root, path), "utf8")).toBe(content)
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest)
    expect(pm.calls).toEqual(calls)
  })

  it("keeps the packages that another enabled feature declares", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/database": "1.0.0", "drizzle-orm": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ host: "cloudflare", database: true, connections: true }`),
    })

    const { exitCode, json } = await remove(["connections", "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ status: "planned", turnedOff: ["connections"], uninstall: { devPackages: [], packages: [] } })
  })

  it("refuses to remove Console when retained source uses its Agent integration packages", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig('{ preset: "netlify", agent: true, console: { auth: false } }'),
      "client.ts": 'import { createClient } from "@libsql/client"\n',
    })

    const refused = await remove(["console", "--yes", "--no-uninstall"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_IN_USE")
    expect(refused.json.references).toContainEqual({ feature: "console", file: "client.ts", line: 1, module: "@libsql/client" })
  })

  it("keeps an edited starter and refuses until --force", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
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

  it("keeps an edited starter's imported packages with --force", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
    const pm = fakePackageManager(root)
    expect((await add(["database", "--name", "default"], root, pm.spawn)).exitCode).toBe(0)
    const path = "server/databases/default.ts"
    const edited = `${await readFile(join(root, path), "utf8")}// app schema\n`
    await writeFile(join(root, path), edited)

    const { exitCode, json } = await remove(["database", "--yes", "--force"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.kept).toEqual([{ path, reason: "edited" }])
    expect(json.references).toEqual([{ feature: "database", file: path }])
    expect(json.uninstall).toEqual({ command: "pnpm remove drizzle-kit", devPackages: ["drizzle-kit"], packages: [] })
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({ dependencies: { "@vite-hub/database": "1.0.0", "drizzle-orm": "1.0.0" } })
    expect(await readFile(join(root, path), "utf8")).toBe(edited)
  })

  it("keeps every starter and its facade's owner package with --keep-files", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
    const pm = fakePackageManager(root)
    expect((await add(["schedule", "--name", "nightly"], root, pm.spawn)).exitCode).toBe(0)
    const path = "server/schedules/nightly.ts"
    const starter = await readFile(join(root, path), "utf8")

    const { exitCode, json } = await remove(["schedule", "--yes", "--keep-files"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.kept).toEqual([{ path, reason: "keep-files" }])
    expect(json.changes.map(change => change.kind)).toEqual(["patch"])
    expect(json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(pm.calls).toHaveLength(1)
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({ dependencies: { "@vite-hub/schedule": "1.0.0" } })
    expect(await readFile(join(root, path), "utf8")).toBe(starter)
  })

  it("keeps every starter with --keep-files", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
    expect((await add(["workflow", "--name", "onboard", "--no-install"], root)).exitCode).toBe(0)

    const { exitCode, json } = await remove(["workflow", "--yes", "--keep-files", "--no-uninstall"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.kept).toEqual([{ path: "server/workflows/onboard.ts", reason: "keep-files" }])
    expect(json.changes.map(change => change.kind)).toEqual(["patch"])
    expect(existsSync(join(root, "server/workflows/onboard.ts"))).toBe(true)
  })

  it.each(["--force", "--keep-files"])("keeps a retained starter's owner package with %s", async (flag) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
    const pm = fakePackageManager(root)
    expect((await add(["schedule", "--name", "nightly"], root, pm.spawn)).exitCode).toBe(0)
    const path = join(root, "server/schedules/nightly.ts")
    if (flag === "--force") await writeFile(path, `${await readFile(path, "utf8")}// Keep this Definition.\n`)
    const content = await readFile(path, "utf8")
    const manifest = await readFile(join(root, "package.json"), "utf8")
    const calls = [...pm.calls]

    const { exitCode, json } = await remove(["schedule", "--yes", flag], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(await readFile(path, "utf8")).toBe(content)
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest)
    expect(pm.calls).toEqual(calls)
  })

  it("refuses a feature that another enabled feature implies, and writes false with --force", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare", agent: true, workflow: true }`) })
    const before = await readFile(join(root, "vite.config.ts"), "utf8")

    const refused = await remove(["workflow", "--yes", "--no-uninstall"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error).toMatchObject({ code: "SETUP_FEATURE_IMPLIED", message: "workflow stays on because agent turns it on." })
    expect(refused.json.impliedBy).toEqual(["agent"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(before)

    const forced = await remove(["workflow", "--yes", "--no-uninstall", "--force"], root)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ host: "cloudflare", agent: true, workflow: false }`))
    expect(await enabled(root, "workflow")).toBe("off")
  })

  it("names the feature that implies Database", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare", comments: true }`) })

    const { exitCode, json } = await remove(["database", "--dry-run"], root)

    expect(exitCode).toBe(3)
    expect(json.impliedBy).toEqual(["comments"])
  })

  it.each([
    {
      config: '{ host: "netlify", agent: true, console: { auth: false } }',
      feature: "console",
      packages: ["@vite-hub/agent", "@libsql/client", "drizzle-orm"],
      uninstall: ["@libsql/client", "drizzle-orm"],
    },
    {
      config: '{ host: "netlify", agent: true, console: { auth: false } }',
      feature: "agent",
      packages: ["@vite-hub/agent", "@libsql/client", "drizzle-orm"],
      uninstall: ["@libsql/client", "@vite-hub/agent", "drizzle-orm"],
    },
    {
      config: '{ host: "node", database: true, agent: true, console: { auth: false } }',
      feature: "database",
      packages: ["@vite-hub/database", "@libsql/client", "drizzle-orm"],
      uninstall: ["@vite-hub/database"],
    },
    {
      config: '{ host: "node", observability: { service: "app", posthog: true } }',
      feature: "observability",
      packages: ["posthog-node"],
      uninstall: ["posthog-node"],
    },
  ])("uninstalls only unused optional packages when removing $feature from $config", async ({ config, feature, packages, uninstall }) => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: Object.fromEntries(packages.map(name => [name, "1.0.0"])), name: "app" }),
      "vite.config.ts": viteConfig(config),
    })

    const { exitCode, json } = await remove([feature, "--dry-run"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect([...json.uninstall.packages].sort()).toEqual([...uninstall].sort())
  })

  it.each([
    { by: "cache", feature: "kv", options: 'host: "netlify", cache: { driver: "kv" }, kv: { driver: "upstash" }' },
    { by: "agent", feature: "database", options: 'agent: { invocations: "database" }, database: true' },
    { by: "agent", feature: "database", options: 'agent: { invocations: { store: "database" } }, database: true' },
    { by: "observability", feature: "agent", options: 'observability: { service: "app", papercuts: true }, agent: true, console: { auth: false }' },
    { by: "observability", feature: "console", options: 'observability: { service: "app", papercuts: true }, agent: true, console: { auth: false }' },
    { by: "observability", feature: "env", options: 'observability: { service: "app", posthog: true }, env: {}' },
  ])("preserves $feature required by $by options ($options)", async ({ by, feature, options }) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig(`{ ${options} }`),
    })
    const before = await snapshot(root)
    const pm = fakePackageManager(root)

    const refused = await remove([feature, "--yes"], root, pm.spawn)

    expect(refused.exitCode, JSON.stringify(refused.json)).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_REQUIRED")
    expect(refused.json.impliedBy).toEqual([by])
    expect(await snapshot(root)).toEqual(before)
    expect(pm.calls).toEqual([])

    const forced = await remove([feature, "--force", "--dry-run"], root)
    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(3)
    expect(forced.json.error?.code).toBe("SETUP_FEATURE_REQUIRED")

    const together = await remove([feature, by, "--yes"], root, pm.spawn)
    expect(together.exitCode, JSON.stringify(together.json.error)).toBe(0)
    expect(await enabled(root, feature)).toBe("off")
    expect(await enabled(root, by)).toBe("off")
  })

  it("preserves a conditional prerequisite that would go off with its last implying feature", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig('{ connections: true, agent: { invocations: "database" } }'),
    })
    const before = await snapshot(root)

    const refused = await remove(["connections", "--yes"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.impliedBy).toEqual(["agent"])
    expect(await snapshot(root)).toEqual(before)
  })

  it.each(["true", "{ auth: false }", '{ authorize: "server/console-authorize.ts" }'])("allows Auth removal with the Console on: %s", async (console) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig(`{ auth: true, console: ${console} }`),
    })

    const result = await remove(["auth", "--yes"], root)

    expect(result.exitCode, JSON.stringify(result.json.error)).toBe(0)
    expect(await enabled(root, "auth")).toBe("off")
    expect(await enabled(root, "console")).toBe("on")
  })

  it("keeps the Console's Agent packages when removing Database", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@libsql/client": "1.0.0", "@vite-hub/database": "1.0.0", "drizzle-orm": "1.0.0" }, devDependencies: { "drizzle-kit": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ host: "cloudflare", agent: true, console: { auth: false }, database: true }`),
    })
    const pm = fakePackageManager(root)

    const { exitCode, json } = await remove(["database", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.uninstall).toMatchObject({ devPackages: ["drizzle-kit"], packages: ["@vite-hub/database"] })
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies).toEqual({ "@libsql/client": "1.0.0", "drizzle-orm": "1.0.0" })
  })

  it("refuses while app code imports the feature, with file and line", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "server/api/doc.get.ts": `import { defineHandler } from "nitro/h3"\n\nimport { useRealtime } from "vite-hub/realtime"\n\nexport default defineHandler(() => useRealtime("docs"))\n`,
      "src/client.ts": `export const load = () => import("@vite-hub/realtime/client")\n`,
      "vite.config.ts": viteConfig(`{ host: "cloudflare", realtime: true }`),
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
    ["types/schedule.d.ts", 'import type { ScheduleDefinition } from "@vite-hub/schedule"\n', "@vite-hub/schedule"],
    ["types/schedule.d.mts", 'export * from "vite-hub/schedule"\n', "vite-hub/schedule"],
    ["types/schedule.d.cts", 'declare module "@vite-hub/schedule" {}\nexport {}\n', "@vite-hub/schedule"],
    ["types/schedule-reference.d.ts", '/// <reference types="@vite-hub/schedule" />\n', "@vite-hub/schedule"],
    ["types/schedule-reference.d.mts", "/// <reference types='vite-hub/schedule' />\n", "vite-hub/schedule"],
    ["src/schedule.ts", 'const load = () => import(/* webpackChunkName: "schedule" */ "@vite-hub/schedule")\n', "@vite-hub/schedule"],
    ["src/schedule.cjs", 'const schedule = require(/* schedule */ "@vite-hub/schedule")\n', "@vite-hub/schedule"],
    ["src/schedule-line.ts", 'const load = () => import(// schedule\n "vite-hub/schedule")\n', "vite-hub/schedule"],
    ["src/schedule-before.ts", 'const load = () => import /* retained target */ ("@vite-hub/schedule")\n', "@vite-hub/schedule"],
    ["src/schedule-before.cjs", 'const schedule = require /* retained target */ ("@vite-hub/schedule")\n', "@vite-hub/schedule"],
    ["src/schedule-before-line.ts", 'const load = () => import // retained target\n ("@vite-hub/schedule")\n', "@vite-hub/schedule"],
    ["src/schedule-both.cjs", 'const schedule = require /* before */ (/* inside */ "vite-hub/schedule")\n', "vite-hub/schedule"],
    ["src/schedule-template.ts", 'const load = () => import(`@vite-hub/schedule/vite`)\n', "@vite-hub/schedule/vite"],
    ["src/schedule-template-facade.ts", 'const load = () => import(`vite-hub/schedule`)\n', "vite-hub/schedule"],
  ])("keeps packages used by a source file: %s", async (path, content, module) => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/schedule": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      [path]: content,
      "vite.config.ts": viteConfig(`{ host: "cloudflare", schedule: true }`),
    })
    const original = await snapshot(root)
    const pm = fakePackageManager(root)

    const refused = await remove(["schedule", "--yes"], root, pm.spawn)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_IN_USE")
    expect(refused.json.references).toEqual([{ feature: "schedule", file: path, line: 1, module }])
    expect(await snapshot(root)).toEqual(original)

    const forced = await remove(["schedule", "--yes", "--force"], root, pm.spawn)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall).toEqual({ devPackages: [], packages: [] })
    expect(pm.calls).toEqual([])
    expect(await readFile(join(root, path), "utf8")).toBe(content)
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(original["package.json"])
  })

  it("ignores generated declaration files when scanning package uses", async () => {
    const root = await createProject({
      ".nuxt/types/schedule.d.ts": 'export * from "@vite-hub/schedule"\n',
      "node_modules/@vite-hub/schedule/index.d.ts": 'export * from "@vite-hub/schedule"\n',
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/schedule": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ host: "cloudflare", schedule: true }`),
    })
    const pm = fakePackageManager(root)

    const { exitCode, json } = await remove(["schedule", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.references).toEqual([])
    expect(pm.calls).toEqual([["pnpm", "remove", "@vite-hub/schedule"]])
  })

  it.each([
    'import(/* @vite-ignore */ "@vite-hub/realtime/client")',
    'import(/* webpackChunkName: "realtime" */ "@vite-hub/realtime/client")',
    'import(// load the client\n "@vite-hub/realtime/client")',
    'require(/* client */ "@vite-hub/realtime/client")',
    'import(`@vite-hub/realtime/client`)',
    'import(/* @vite-ignore */ `@vite-hub/realtime/client`)',
  ])("keeps dependencies used by a static import specifier: %s", async (expression) => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "src/client.ts": `export const load = () => ${expression}\n`,
      "vite.config.ts": viteConfig(`{ host: "cloudflare", realtime: true }`),
    })
    const before = await snapshot(root)

    const refused = await remove(["realtime", "--yes"], root)

    expect(refused.exitCode).toBe(3)
    expect(refused.json.error?.code).toBe("SETUP_FEATURE_IN_USE")
    expect(refused.json.references).toEqual([{ feature: "realtime", file: "src/client.ts", line: 1, module: "@vite-hub/realtime/client" }])
    expect(await snapshot(root)).toEqual(before)

    const forced = await remove(["realtime", "--yes", "--force"], root)

    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.uninstall).toEqual({ devPackages: [], packages: [] })
  })

  it("writes false for a feature that is on by default", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })

    const { exitCode, json } = await remove(["env", "--yes"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.turnedOff).toEqual(["env"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ host: "node", env: false }`))
    expect((await remove(["env", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("writes false for a feature that a discovered file turns on, only with --force", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "server/comments.ts": "export default {}\n",
      "vite.config.ts": viteConfig(`{ host: "node", comments: true }`),
    })

    const refused = await remove(["comments", "--dry-run"], root)
    expect(refused.exitCode).toBe(3)
    expect(refused.json.references).toEqual([{ feature: "comments", file: "server/comments.ts" }])

    const forced = await remove(["comments", "--yes", "--force", "--no-uninstall"], root)
    expect(forced.exitCode, JSON.stringify(forced.json.error)).toBe(0)
    expect(forced.json.kept).toEqual([])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ host: "node", comments: false }`))
  })

  it.each([
    'rootDir: process.env.APP_ROOT',
    'serverDir: process.env.SERVER_DIR',
    'extends: ["./base"]',
  ])("refuses removal when Nuxt discovery roots need evaluation: %s", async (layout) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "nuxt.config.ts": `export default defineNuxtConfig({ ${layout}, modules: [["vite-hub/nuxt", { host: "node", comments: true }]] })\n`,
      "server/comments.ts": "export default {}\n",
    })
    const before = await snapshot(root)

    const { exitCode, json } = await remove(["comments", "--yes"], root)

    expect(exitCode).toBe(3)
    expect(json.error?.code).toBe("SETUP_SERVER_DIR_MANUAL")
    expect(await snapshot(root)).toEqual(before)
  })

  it("plans in a dry run and asks for --yes without a terminal, writing nothing", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "vercel", kv: true }`) })
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
    expect(human.stdout).toContain("-  plugins: [vitehub({ host: \"vercel\", kv: true })],")
    expect(await snapshot(root)).toEqual(before)
  })

  it("lists the uninstall command in nextSteps with --no-uninstall and mentions host resources", async () => {
    const root = await createProject({
      ".vitehub/data/kv/key": "value",
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ host: "cloudflare", kv: true, realtime: true }`),
    })

    const { exitCode, json } = await remove(["kv", "realtime", "--yes", "--no-uninstall"], root)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(viteConfig(`{ host: "cloudflare" }`))
    expect(json.nextSteps).toContain("Uninstall the packages: pnpm remove @vite-hub/realtime")
    expect(json.nextSteps.join("\n")).toContain("ViteHub does not delete host resources.")
    expect(json.nextSteps.join("\n")).toContain("Local data in .vitehub/data stays.")
    expect(await readFile(join(root, ".vitehub/data/kv/key"), "utf8")).toBe("value")
  })

  it("is unchanged for a feature that is already off", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", kv: false }`) })

    const { exitCode, json } = await remove(["kv"], root)

    expect(exitCode).toBe(0)
    expect(json).toMatchObject({ changes: [], status: "unchanged", turnedOff: [] })
  })

  it("returns the snippet to paste for an expression", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", kv: process.env.KV ? true : false }`) })

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

  it.each([
    { feature: "kv", dependent: "cache", options: "kv: true", value: '{ driver: "kv" }' },
    { feature: "env", dependent: "observability", options: "env: true", value: '{ service: "app", posthog: { apiKey: "key" } }' },
    { feature: "agent", dependent: "observability", options: "agent: true, console: { auth: false }", value: "{ papercuts: true }" },
    { feature: "console", dependent: "observability", options: "agent: true, console: { auth: false }", value: "{ papercuts: true }" },
    { feature: "database", dependent: "agent", options: "database: true", value: '{ invocations: "database" }' },
    { feature: "database", dependent: "agent", options: "database: true", value: '{ invocations: { store: "database" } }' },
  ])("preserves $feature when dynamic $dependent options may require it ($value)", async ({ feature, dependent, options, value }) => {
    const config = `const options = ${value}\n${viteConfig(`{ host: "node", ${options}, ${dependent}: options }`)}`
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": config })
    const before = await snapshot(root)
    for (const flags of [[], ["--force"]]) {
      const refused = await remove([feature, "--yes", ...flags], root)
      expect(refused.exitCode, refused.stdout).toBe(3)
      expect(refused.json.error).toMatchObject({ code: "SETUP_FEATURE_REQUIRED" })
      expect(await snapshot(root)).toEqual(before)
    }
  })

  it.each([
    { file: "vite.config.ts", config: viteConfig('{ host: "node", env: true, observability: { posthog: options } }') },
    { file: "nuxt.config.ts", config: 'export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], vitehub: { host: "node", env: true, observability: { posthog: options } } })' },
    { file: "nuxt.config.ts", config: 'export default defineNuxtConfig({ modules: [["vite-hub/nuxt", { host: "node", env: true, observability: { posthog: options } }]] })' },
  ])("preserves prerequisites for nested dynamic options ($config)", async ({ file, config }) => {
    const root = await createProject({ "package.json": pnpmManifest, [file]: `const options = { apiKey: "key" }\n${config}` })
    const before = await snapshot(root)
    const refused = await remove(["env", "--yes"], root)
    expect(refused.exitCode, refused.stdout).toBe(3)
    expect(refused.json.error).toMatchObject({ code: "SETUP_FEATURE_REQUIRED" })
    expect(await snapshot(root)).toEqual(before)
  })

  it.each([
    { feature: "kv", options: 'kv: true, cache: { driver: "memory" }' },
    { feature: "console", options: 'console: { auth: false }, connections: { management: false }' },
    { feature: "env", options: 'env: true, observability: { service: "app", posthog: false, papercuts: false }' },
    { feature: "database", options: 'database: true, agent: { invocations: "filesystem" }' },
    { feature: "database", options: 'database: true, agent: { invocations: { store: "filesystem" } }' },
  ])("removes $feature when literal options do not require it ($options)", async ({ feature, options }) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", ${options} }`) })
    const removed = await remove([feature, "--yes"], root)
    expect(removed.exitCode, removed.stdout).toBe(0)
    expect(await enabled(root, feature)).toBe("off")
  })

  it.each([
    { feature: "kv", dependent: "cache", options: 'kv: true, cache: { driver: "kv" }' },
    { feature: "env", dependent: "observability", options: 'env: true, observability: { posthog: true }' },
    { feature: "agent", dependent: "observability", options: 'agent: true, console: { auth: false }, observability: { papercuts: true }' },
    { feature: "console", dependent: "observability", options: 'agent: true, console: { auth: false }, observability: { papercuts: true }' },
    { feature: "database", dependent: "agent", options: 'database: true, agent: { invocations: "database" }' },
    { feature: "database", dependent: "agent", options: 'database: true, agent: { invocations: { store: "database" } }' },
  ])("refuses to remove $feature while $dependent requires it ($options)", async ({ feature, dependent, options }) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", ${options} }`) })
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
      "nuxt.config.ts": `export default defineNuxtConfig({ ${config} modules: [["vite-hub/nuxt", { host: "node" }]] })\n`,
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

  it("uninstalls an unused runtime package declared in devDependencies", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ devDependencies: { "@vite-hub/realtime": "1.0.0" }, name: "app", packageManager: "pnpm@10.0.0" }),
      "vite.config.ts": viteConfig(`{ host: "cloudflare", realtime: true }`),
    })
    const pm = fakePackageManager(root)

    const { exitCode, json } = await remove(["realtime", "--yes"], root, pm.spawn)

    expect(exitCode, JSON.stringify(json.error)).toBe(0)
    expect(json.uninstall).toEqual({ command: "pnpm remove @vite-hub/realtime", devPackages: [], packages: ["@vite-hub/realtime"] })
    expect(pm.calls).toEqual([["pnpm", "remove", "@vite-hub/realtime"]])
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual({ name: "app", packageManager: "pnpm@10.0.0" })
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
      "vite.config.ts": viteConfig(`{ host: "cloudflare", realtime: true }`),
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
      "vite.config.ts": viteConfig(`{ host: "cloudflare", realtime: true }`),
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
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "cloudflare" }`) })
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
})
