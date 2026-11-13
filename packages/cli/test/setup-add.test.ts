import { cp, readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { locateViteHubConfig } from "@vite-hub/internal/config-edit"
import { featureIds, featureSupport } from "@vite-hub/internal/features"
import { describe, expect, it } from "vitest"

import { createProject, pnpmManifest, runSetup, viteConfig } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { SetupAddPlan, SetupError, SetupMissing, SetupStatus } from "../src/setup/index.ts"

const docsHosts = fileURLToPath(new URL("../../../fixtures/docs-hosts/", import.meta.url))

/** A temp copy of a `fixtures/docs-hosts` folder. */
async function copyFixture(name: string): Promise<string> {
  const root = await createProject()
  await cp(join(docsHosts, name), root, { recursive: true })
  return root
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  return Object.fromEntries(await Promise.all(files.map(async file => [relative(root, file), await readFile(file, "utf8")] as const)))
}

type AddResult = SetupAddPlan & { error?: SetupError, missing?: SetupMissing[], rerun?: string, snippet?: string }

function add(args: string[], root: string, spawn?: ViteHubCliSpawn) {
  return runSetup<AddResult>(["add", ...args, "--json"], root, {}, { spawn })
}

const fixtures: ReadonlyArray<readonly [string, ViteHubHost, string]> = [
  ["cloudflare", "cloudflare", "vite.config.ts"],
  ["vercel", "vercel", "vite.config.ts"],
  ["netlify", "netlify", "vite.config.ts"],
  ["deno", "deno", "vite.config.ts"],
  ["node-self-hosted", "node", "vite.config.ts"],
  ["installation", "node", "nuxt.config.ts"],
]

describe("vitehub add", () => {
  it.each([
    ['{ host: "netlify", agent: true }', ["observability", "--option", "observability.service=api"]],
    ['{ host: "netlify" }', ["agent", "observability", "--option", "observability.service=api"]],
    ['{ host: "netlify", observability: { service: "api" } }', ["agent"]],
    ['{ host: "node", agent: { runtime: "deno" } }', ["observability", "--option", "observability.service=api"]],
    ['{ host: "node" }', ["agent", "observability", "--option", "agent.runtime=deno", "--option", "observability.service=api"]],
  ] as const)("rejects Observability with non-Nitro Agents before installing or writing (%s)", async (options, args) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const before = await snapshot(root)
    let spawned = false
    const result = await add([...args, "--yes"], root, async () => {
      spawned = true
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.why).toContain("Nitro-hosted Agents")
    expect(spawned).toBe(false)
    expect(await snapshot(root)).toEqual(before)
  })

  it.each(['{ host: "netlify", agent: false }', '{ host: "node", agent: true }'])("accepts compatible Observability and Agent configuration (%s)", async (options) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const result = await add(["observability", "--option", "observability.service=api", "--dry-run"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).toContain("evlog")
    expect(result.json.install.packages).not.toContain("posthog-node")
  })

  it("adds Observability without a service and installs the Agent package only with one", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node" }') })
    const plain = await add(["observability", "--dry-run"], root)
    expect(plain.exitCode, plain.stdout).toBe(0)
    expect(plain.json.install.packages).toContain("evlog")
    expect(plain.json.install.packages).not.toContain("@vite-hub/agent")
    const telemetry = await add(["observability", "--option", "observability.service=api", "--dry-run"], root)
    expect(telemetry.json.install.packages).toContain("@vite-hub/agent")
  })

  it("adds a Logs source under observability", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig('{ host: "node" }'),
      "server/logs.ts": "export default {}\n",
    })
    const applied = await add(["observability", "--option", "observability.logs.source=./server/logs.ts", "--no-install", "--yes"], root)
    expect(applied.exitCode, applied.stdout).toBe(0)
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && config.site.keys.observability).toMatchObject({ value: { logs: { source: "./server/logs.ts" } } })
  })

  it("enables Server Env and installs PostHog when selected", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node", env: false }') })
    const args = ["observability", "--option", "observability.service=api", "--option", "observability.posthog.apiKey=key", "--no-install", "--yes"]
    const result = await add(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.features).toContain("env")
    expect(result.json.install.packages).toContain("posthog-node")
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && config.site.keys.env).toMatchObject({ value: {} })
    expect((await add(args, root)).json.status).toBe("unchanged")
  })

  it.each(['{ host: "node" }', '{ host: "node", workspace: false }'])("enables Workspace for the Realtime starter (%s)", async (options) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const args = ["realtime", "--option", "realtime.authority=memory", "--name", "docs", "--no-install", "--yes"]
    const result = await add(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.features).toContain("workspace")
    expect(result.json.install.packages).toContain("@vite-hub/workspace")
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && config.site.keys.workspace).toMatchObject({ value: true })
    expect((await add(args, root)).json.status).toBe("unchanged")
  })

  it.each([
    ["console", []],
    ["observability", ["--option", "observability.service=api", "--option", "observability.papercuts=true"]],
  ] as const)("preserves disabled Comments and Database when %s requires only Console", async (feature, options) => {
    for (const comments of [undefined, false]) {
      const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "deno", ${comments === false ? "comments: false," : ""} database: false }`) })
      const result = await add([feature, ...options, "--option", "console.auth=false", "--no-install", "--yes"], root)
      expect(result.exitCode, result.stdout).toBe(0)
      expect(result.json.install.packages).not.toContain("@vite-hub/comments")
      expect(result.json.install.packages).not.toContain("@vite-hub/database")
      const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
      expect(config.ok && config.site.keys.database).toMatchObject({ value: false })
      expect(config.ok && config.site.keys.comments).toEqual(comments === false ? { kind: "literal", value: false } : undefined)
    }
  })

  it("plans Evlog as an Observability production dependency", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node" }') })
    const result = await add(["observability", "--option", "observability.service=api", "--dry-run"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).toContain("evlog")
  })

  it.each([
    '{ host: "netlify" }',
    '{ host: "node", agent: { runtime: "deno" } }',
  ])("rejects papercut reporting without Nitro-hosted Agents (%s)", async (options) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const before = await snapshot(root)
    let spawned = false
    const result = await add(["observability", "--option", "observability.service=api", "--option", "observability.papercuts=true", "--yes"], root, async () => {
      spawned = true
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.why).toContain("Nitro-hosted Agents")
    expect(spawned).toBe(false)
    expect(await snapshot(root)).toEqual(before)
  })

  it("turns the Console on for papercut reporting, with signed calls", async () => {
    for (const host of ["node", "cloudflare", "vercel", "deno"] as const) {
      const root = await createProject({
        "package.json": pnpmManifest,
        "vite.config.ts": viteConfig(`{ host: "${host}", agent: false, console: false, database: false }`),
      })
      const args = ["observability", "--option", "observability.service=api", "--option", "observability.papercuts=true", "--no-install", "--yes"]
      const applied = await add(args, root)
      expect(applied.exitCode, applied.stdout).toBe(0)
      expect(applied.json.features).toEqual(expect.arrayContaining(["observability", "console", "agent"]))
      expect(applied.json.install.packages).not.toContain("@vite-hub/database")
      const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
      expect(config.ok && config.site.keys.console).toMatchObject({ value: true })
      expect(config.ok && config.site.keys.agent).toMatchObject({ value: true })
      expect((await add(args, root)).json.status).toBe("unchanged")
    }
  })

  it("adds the Connections management API without the Console", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node", console: false }') })
    const applied = await add(["connections", "--option", "connections.management=true", "--no-install", "--yes"], root)
    expect(applied.exitCode, applied.stdout).toBe(0)
    expect(applied.json.features).not.toContain("console")
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && config.site.keys.console).toMatchObject({ value: false })
  })

  it("turns the Console on with signed calls, and needs no access choice", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node" }') })
    const added = await add(["console", "--no-install", "--yes"], root)
    expect(added.exitCode, added.stdout).toBe(0)
    // The Console app is hosted, so the app installs no Console package.
    expect(added.json.install.packages).not.toContain("@vite-hub/console-client")
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("console: true")
    expect((await add(["console", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it.each(["agent.invocations=database", "agent.invocations.store=database"])("enables Database for %s on native and explicit hosts", async (option) => {
    for (const host of ["node", "vercel"]) {
      const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "${host}", database: false }`) })
      const before = await snapshot(root)
      const args = ["agent", "--option", option, "--no-install", "--yes"]
      if (host === "vercel") {
        const missing = await add(args, root)
        expect(missing.exitCode, missing.stdout).toBe(2)
        expect(missing.json.missing).toEqual([{ field: "database.connection" }])
        expect(await snapshot(root)).toEqual(before)
        args.push("--option", "database.connection.url=libsql://example.com")
      }
      const result = await add(args, root)
      expect(result.exitCode, result.stdout).toBe(0)
      expect(result.json.features).toContain("database")
      expect(result.json.install.packages).toEqual(expect.arrayContaining(["@vite-hub/database", "drizzle-orm"]))
      expect(result.json.install.devPackages).toContain("drizzle-kit")
      const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
      expect(config.ok && config.site.keys.database).toMatchObject({ value: host === "node" ? true : { connection: { url: "libsql://example.com" } } })
      expect((await add(args, root)).json.status).toBe("unchanged")
    }
  })

  it.each([false, true])("rejects the Agent Deno runtime on Deno (existing: %s) before installing or writing", async (existing) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "deno"${existing ? ', agent: { runtime: "deno" }' : ""} }`) })
    const before = await snapshot(root)
    let spawned = false
    const result = await add(["agent", ...existing ? [] : ["--option", "agent.runtime=deno"], "--name", "helper", "--yes"], root, async () => {
      spawned = true
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_FEATURE_UNSUPPORTED")
    expect(result.json.error?.why).toContain("Nitro runtime")
    expect(spawned).toBe(false)
    expect(await snapshot(root)).toEqual(before)
  })

  it.each([
    ["node", "realtime", "realtime.authority=cloudflare"],
    ["node", "realtime", "realtime.authority=auto"],
    ["cloudflare", "realtime", "realtime.authority=memory"],
    ["netlify", "cache", "cache.driver=fs-lite"],
  ])("rejects conflicting provider options on %s: %s %s before installing or writing", async (host, feature, option) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "${host}" }`) })
    const before = await snapshot(root)
    let spawned = false
    const result = await add([feature, "--option", option, "--yes"], root, async () => {
      spawned = true
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_FEATURE_UNSUPPORTED")
    expect(spawned).toBe(false)
    expect(await snapshot(root)).toEqual(before)
  })

  it.each([
    ["node", "realtime", "realtime.authority=memory"],
    ["cloudflare", "realtime", "realtime.authority=cloudflare"],
    ["cloudflare", "realtime", "realtime.authority=auto"],
    ["node", "cache", "cache.driver=fs-lite"],
  ])("preserves supported provider options on %s: %s %s", async (host, feature, option) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "${host}" }`) })
    expect((await add([feature, "--option", option, "--no-install", "--yes"], root)).exitCode).toBe(0)
  })

  it.each(["agent.invocations=memory", "agent.invocations=database", "agent.invocations.store=database"])("rejects %s on Netlify before installing or writing", async (option) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "netlify", database: { connection: { url: "libsql://example.com" } } }') })
    const before = await snapshot(root)
    let spawned = false
    const result = await add(["agent", "--option", option, "--name", "helper", "--yes"], root, async () => {
      spawned = true
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_FEATURE_UNSUPPORTED")
    expect(result.json.error?.why).toContain("agent.invocations")
    expect(spawned).toBe(false)
    expect(await snapshot(root)).toEqual(before)
  })

  it("allows disabled Agent invocations on Netlify", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "netlify" }') })
    const result = await add(["agent", "--option", "agent.invocations=false", "--no-install", "--yes"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("agent: { invocations: false }")
  })

  it("plans packages for an already-enabled Database prerequisite", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "cloudflare", database: true }') })
    const before = await snapshot(root)
    const result = await add(["comments", "--dry-run"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.implied).not.toContain("database")
    expect(result.json.install.packages).toEqual(expect.arrayContaining(["@vite-hub/comments", "@vite-hub/database", "drizzle-orm"]))
    expect(result.json.install.devPackages).toContain("drizzle-kit")
    expect(await snapshot(root)).toEqual(before)
  })

  it.each([
    ['{ host: "node", agent: true }', ["console", "--option", "console.auth=false"]],
    ['{ host: "node", console: { auth: false } }', ["agent"]],
    ['{ host: "node" }', ["console", "agent", "--option", "console.auth=false"]],
  ])("plans the Console Agent journal packages with %s", async (options, args) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(options) })
    const calls: string[][] = []
    const result = await add([...args, "--yes"], root, async (_command, spawnArgs) => {
      calls.push([...spawnArgs])
      return { exitCode: 0 }
    })
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).toContain("@libsql/client")
    expect(result.json.install.packages.filter(name => name === "drizzle-orm")).toHaveLength(1)
    expect(calls[0]).toContain("@libsql/client")
    expect(result.json.install.packages).not.toContain("@better-auth/oauth-provider")
  })

  it("does not install session sign-in packages for Cloudflare Access", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "cloudflare" }') })
    const result = await add(["console", "--option", "console.auth.provider=cloudflare-access", "--option", "console.auth.teamDomain=example.cloudflareaccess.com", "--option", "console.auth.audience=console", "--dry-run"], root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.install.packages).not.toContain("@vite-hub/auth")
    expect(result.json.install.packages).not.toContain("@better-auth/oauth-provider")
  })

  it.each([
    'serverDir: process.env.SERVER_DIR || "backend"',
    'rootDir: process.env.APP_ROOT || "app"',
    'extends: ["./base"]',
  ])("rejects Nuxt starters when the application server directory is unresolved: %s", async (options) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${options}, vitehub: { host: "node" } })`,
    })
    const before = await snapshot(root)
    const result = await add(["queue", "--name", "jobs", "--yes"], root)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_SERVER_DIR_MANUAL")
    expect(await snapshot(root)).toEqual(before)
    expect((await add(["queue", "--no-install", "--yes"], root)).exitCode).toBe(0)
  })

  it.each(fixtures)("adds each native feature to a copy of docs-hosts/%s once", async (fixture, host, configFile) => {
    const native = featureIds.filter(id => featureSupport(id, host).level === "native")
    expect(native.length).toBeGreaterThan(5)
    const files = Object.fromEntries(await Promise.all(["vite.config.ts", "nuxt.config.ts"].map(async file => [file, await readFile(join(docsHosts, fixture, file), "utf8").catch(() => undefined)] as const)))
    for (const id of native) {
      // Only the config files, so the loop stays fast on a slow temp disk.
      const root = await createProject(Object.fromEntries(Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined)))
      const before = await readFile(join(root, configFile), "utf8")
      const options = [
        ...(id === "console" ? ["--option", "console.auth=false"] : []),
        ...(host === "node" && id === "schedule" ? ["--option", "schedule.runtime.driver=process"] : []),
        ...(featureSupport("database", host).level === "explicit" && ["comments", "connections"].includes(id) ? ["--option", "database.connection.url=libsql://example.com"] : []),
      ]

      const first = await add([id, ...options, "--no-install", "--yes"], root)
      expect(first.exitCode, `${id}: ${first.stdout}`).toBe(0)
      expect(first.loadConfig).not.toHaveBeenCalled()
      const after = await readFile(join(root, configFile), "utf8")
      const status = (await runSetup<SetupStatus>(["status", "--json"], root)).json
      expect(status.host.name).toBe(host)
      expect(status.features.find(feature => feature.id === id)?.enabled, id).toBe("on")
      if (first.json.status === "applied") {
        expect(first.json.changes, id).toEqual([expect.objectContaining({ after, before, kind: "patch", path: configFile })])
        expect(first.json.changes[0]!.diff, id).toMatch(new RegExp(`^\\+.*\\b${id}: (true|\\{)`, "mu"))
      }
      else {
        expect(after, id).toBe(before)
      }

      const second = await add([id, ...options, "--no-install", "--yes"], root)
      expect(second.exitCode, id).toBe(0)
      expect(second.json).toMatchObject({ changes: [], status: "unchanged" })
      expect(await readFile(join(root, configFile), "utf8"), id).toBe(after)
    }
  }, 30_000)

  it("lists implied features without writing their keys", async () => {
    const root = await copyFixture("node-self-hosted")

    const { exitCode, json } = await add(["agent", "--no-install", "--yes"], root)

    expect(exitCode).toBe(0)
    expect(json.implied).toEqual(["workflow"])
    expect(json.install).toMatchObject({ command: "npm install @vite-hub/agent @vite-hub/workflow", packages: ["@vite-hub/agent", "@vite-hub/workflow"] })
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && Object.keys(config.site.keys)).toEqual(["host", "kv", "agent"])
  })

  it.each([
    ['rootDir: "app"', "app/server"],
    ['serverDir: "backend"', "backend"],
    ['rootDir: "app", serverDir: "backend"', "app/backend"],
  ])("writes Nuxt starters into the application server directory: %s", async (options, serverDir) => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${options}, vitehub: { host: "node" } })`,
    })
    const args = ["queue", "database", "--name", "jobs", "--no-install", "--yes"]
    const result = await add(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    const files = Object.keys(await snapshot(root))
    expect(files).toContain(`${serverDir}/queues/jobs.ts`)
    expect(files).toContain(`${serverDir}/databases/jobs.ts`)
    expect(files.some(file => file.startsWith("server/"))).toBe(false)
    expect((await add(args, root)).json.status).toBe("unchanged")
  })

  it.each(["schedule.runtime.intervalMs=1000", "schedule.runtime.driver=other", "schedule.runtime=false"])("requires a valid Node Schedule runtime driver for %s", async (option) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const before = await snapshot(root)
    const result = await add(["schedule", "--option", option, "--no-install", "--yes"], root)
    expect(result.exitCode).toBe(2)
    expect(result.json.missing).toEqual([{ choices: ["process"], field: "schedule.runtime.driver" }])
    expect(await snapshot(root)).toEqual(before)
    const rerun = await runSetup<AddResult>(result.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode, rerun.stdout).toBe(0)
    const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
    expect(config.ok && config.site.keys.schedule).toMatchObject({ value: { runtime: { driver: "process", ...(option.includes("intervalMs") ? { intervalMs: 1000 } : {}) } } })
  })

  it.each(["node", "netlify"])("enables a disabled Database prerequisite on %s", async (host) => {
    for (const feature of ["comments", "connections"]) {
      const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "${host}", database: false }`) })
      if (host === "netlify") {
        const before = await snapshot(root)
        const first = await add([feature, "--no-install", "--yes"], root)
        expect(first.exitCode).toBe(2)
        expect(first.json.missing).toEqual([{ field: "database.connection" }])
        expect(await snapshot(root)).toEqual(before)
      }
      const options = host === "netlify" ? ["--option", "database.connection.url=libsql://example.com"] : []
      const result = await add([feature, ...options, "--no-install", "--yes"], root)
      expect(result.exitCode, result.stdout).toBe(0)
      expect(result.json.features).toContain("database")
      expect(result.json.install.packages).toContain("@vite-hub/database")
      const config = locateViteHubConfig("vite.config.ts", await readFile(join(root, "vite.config.ts"), "utf8"))
      expect(config.ok && config.site.keys.database).toMatchObject({ value: host === "node" ? true : { connection: { url: "libsql://example.com" } } })
      expect((await add([feature, ...options, "--no-install", "--yes"], root)).json.status).toBe("unchanged")
    }
  })

  it("rejects a config changed during installation before writing starters", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const changed = viteConfig(`{ host: "node", kv: true }`)
    const spawn: ViteHubCliSpawn = async () => {
      await writeFile(join(root, "vite.config.ts"), changed)
      return { exitCode: 0 }
    }
    const result = await add(["schedule", "--option", "runtime.driver=process", "--name", "jobs", "--yes"], root, spawn)
    expect(result.exitCode).toBe(4)
    expect(result.json.error?.code).toBe("SETUP_STALE_PLAN")
    expect(await snapshot(root)).toEqual({ "package.json": pnpmManifest, "vite.config.ts": changed })
  })

  it("exits 3 for a feature that the host does not support and writes nothing", async () => {
    const root = await copyFixture("netlify")
    const before = await snapshot(root)

    const { exitCode, json } = await add(["queue", "--yes"], root)

    expect(exitCode).toBe(3)
    expect(json.error).toMatchObject({ code: "SETUP_FEATURE_UNSUPPORTED", message: "queue is not supported on the netlify host." })
    expect(json.error?.fix).toContain("vitehub catalog")
    expect(await snapshot(root)).toEqual(before)
  })

  it("exits 2 with missing and a rerun that works when the host needs an explicit option", async () => {
    const root = await copyFixture("vercel")

    const first = await add(["email", "--no-install", "--yes"], root)

    expect(first.exitCode).toBe(2)
    expect(first.json.error?.code).toBe("SETUP_INPUT_NEEDED")
    expect(first.json.missing).toEqual([{ choices: ["resend"], field: "email.driver" }])
    expect(first.json.rerun).toBe("vitehub add email --option email.driver=resend --no-install --yes --json")

    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(rerun.json.status).toBe("applied")
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("email: { driver: 'resend' },")

    // The config now sets the option, so the plain command needs no input and changes nothing.
    expect((await add(["email", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("adds kv with the cache driver that Netlify needs", async () => {
    const root = await copyFixture("netlify")

    const { json } = await add(["cache", "--no-install"], root)

    expect(json.missing).toEqual([{ choices: ["kv"], field: "cache.driver" }, { choices: ["upstash"], field: "kv.driver" }])
    expect(json.rerun).toBe("vitehub add cache kv --option cache.driver=kv --option kv.driver=upstash --no-install --yes --json")
    const rerun = await runSetup<AddResult>(json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("kv: { driver: 'upstash' }")
  })

  it("collects the KV prerequisite when the cache driver is supplied", async () => {
    const root = await copyFixture("netlify")
    const before = await snapshot(root)

    const first = await add(["cache", "--option", "cache.driver=kv", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(2)
    expect(first.json.missing).toEqual([{ choices: ["upstash"], field: "kv.driver" }])
    expect(await snapshot(root)).toEqual(before)

    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("kv: { driver: 'upstash' }")
    expect((await add(["cache", "--option", "cache.driver=kv", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it.each([["netlify", "upstash"], ["node", "fs-lite"]])("enables supplied cache prerequisites on %s", async (host, driver) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "${host}" }`) })
    const args = ["cache", "--option", "cache.driver=kv", "--option", `kv.driver=${driver}`, "--no-install", "--yes"]

    const result = await add(args, root)
    expect(result.exitCode, result.stdout).toBe(0)
    expect(result.json.features).toEqual(["cache", "kv"])
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain(`kv: { driver: "${driver}" }`)
    expect((await add(args, root)).json.status).toBe("unchanged")
  })

  it("requires a wake configuration for Node Schedules", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const before = await snapshot(root)

    const first = await add(["schedule", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(2)
    expect(first.json.missing).toEqual([{ choices: ["process"], field: "schedule.runtime.driver" }])
    expect(await snapshot(root)).toEqual(before)

    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain("schedule: { runtime: { driver: \"process\" } }")
    expect((await add(["schedule", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("preserves manual Node Schedule wake ownership", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", schedule: { providerOutput: false } }`) })
    expect((await add(["schedule", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("repairs a Node Schedule wake configuration that selects provider output", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node", schedule: { runtime: { driver: "process" }, providerOutput: "standalone" } }`) })
    const first = await add(["schedule", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(2)
    expect(first.json.missing).toEqual([{ choices: ["auto"], field: "schedule.providerOutput" }])
    const rerun = await runSetup<AddResult>(first.json.rerun!.split(" ").slice(1), root)
    expect(rerun.exitCode).toBe(0)
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain('providerOutput: "auto"')
  })

  it.each(["netlify", "deno"])("collects provider inputs for implied Database features on %s", async (host) => {
    for (const feature of ["comments", "connections"]) {
      const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "${host}" }`) })
      const before = await snapshot(root)

      const first = await add([feature, "--no-install", "--yes"], root)
      expect(first.exitCode, feature).toBe(2)
      expect(first.json.missing).toEqual([{ field: "database.connection" }])
      expect(first.json.rerun).toBeUndefined()
      expect(await snapshot(root)).toEqual(before)

      const second = await add([feature, "--option", "database.connection.url=libsql://example.com", "--no-install", "--yes"], root)
      expect(second.exitCode, second.stdout).toBe(0)
      expect(second.json.implied).toContain("database")
      expect(second.json.nextSteps.some(step => step.includes("Set `database.connection`"))).toBe(false)
      expect(await readFile(join(root, "vite.config.ts"), "utf8")).toContain('database: { connection: { url: "libsql://example.com" } }')
      expect((await add([feature, "--no-install", "--yes"], root)).json.status).toBe("unchanged")
    }
  })

  it("rejects the Cloudflare Email driver on other hosts before writing", async () => {
    const root = await copyFixture("vercel")
    const before = await snapshot(root)
    const result = await add(["email", "--option", "email.driver=cloudflare-email", "--yes"], root)
    expect(result.exitCode).toBe(3)
    expect(result.json.error?.code).toBe("SETUP_FEATURE_UNSUPPORTED")
    expect(await snapshot(root)).toEqual(before)
  })

  it("builds the feature object from --option", async () => {
    const root = await copyFixture("node-self-hosted")

    const { exitCode, json } = await add(["schedule", "--option", "runtime.driver=process", "--option", "schedule.providerOutput=false", "--no-install", "--yes"], root)

    expect(exitCode).toBe(0)
    expect(json.changes[0]!.diff).toContain("+      schedule: { runtime: { driver: 'process' }, providerOutput: false },")
    expect((await add(["schedule", "--option", "runtime.driver=process", "--no-install", "--yes"], root)).json.status).toBe("unchanged")
  })

  it("writes nothing with --dry-run", async () => {
    const root = await copyFixture("cloudflare")
    const before = await snapshot(root)

    const { exitCode, json, stdout } = await add(["kv", "queue", "--name", "welcome-email", "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(stdout.trim().split("\n")).toHaveLength(1)
    expect(json).toMatchObject({ features: ["kv", "queue"], host: { name: "cloudflare", source: "config" }, status: "planned" })
    expect(json.changes.map(change => [change.kind, change.path])).toEqual([["create", "server/queues/welcome-email.ts"], ["patch", "vite.config.ts"]])
    expect(await snapshot(root)).toEqual(before)

    const human = await runSetup(["add", "kv", "--dry-run"], root)
    expect(human.stdout).toContain("+++ b/vite.config.ts\n")
    expect(human.stdout).toContain("+      kv: true,\n")
    expect(await snapshot(root)).toEqual(before)
  })

  it("asks for --yes without a terminal and writes nothing", async () => {
    const root = await copyFixture("cloudflare")
    const before = await snapshot(root)

    const { exitCode, json } = await add(["kv"], root)

    expect(exitCode).toBe(2)
    expect(json).toMatchObject({ error: { code: "CLI_R0004" }, rerun: "vitehub add kv --yes --json", status: "planned" })
    expect(json.changes).toHaveLength(1)
    expect(await snapshot(root)).toEqual(before)
  })

  it("creates a starter Definition and never overwrites a file", async () => {
    const root = await copyFixture("cloudflare")

    const first = await add(["queue", "--name", "welcome-email", "--no-install", "--yes"], root)
    expect(first.exitCode).toBe(0)
    expect(first.json.changes.map(change => change.path)).toEqual(["server/queues/welcome-email.ts"])
    const starter = await readFile(join(root, "server/queues/welcome-email.ts"), "utf8")
    expect(starter).toContain(`import { defineQueue } from "vite-hub/queue"`)

    expect((await add(["queue", "--name", "welcome-email", "--no-install", "--yes"], root)).json.status).toBe("unchanged")

    await writeFile(join(root, "server/queues/welcome-email.ts"), `${starter}// edited\n`)
    const conflict = await add(["queue", "--name", "welcome-email", "--no-install", "--yes"], root)
    expect(conflict.exitCode).toBe(3)
    expect(conflict.json.error?.code).toBe("SETUP_FILE_EXISTS")
    expect(await readFile(join(root, "server/queues/welcome-email.ts"), "utf8")).toBe(`${starter}// edited\n`)
  })

  it("rejects --name for a feature without Definitions and an unsafe name", async () => {
    const root = await copyFixture("cloudflare")

    expect((await add(["kv", "--name", "cache"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["queue", "--name", "../escape"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["kv", "--option", "nope"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["sandboxTask", "--option", "driver=x"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["email", "--option", "database.connection.url=libsql://example.com"], root)).json.error?.code).toBe("CLI_R0003")
    expect((await add(["nope"], root)).json.error?.code).toBe("CLI_R0003")
  })

  it("exits 2 with the feature choices when no feature is named", async () => {
    const root = await copyFixture("cloudflare")

    const { exitCode, json } = await add([], root)

    expect(exitCode).toBe(2)
    expect(json.missing).toEqual([{ choices: [...featureIds], field: "feature" }])
  })

  it("exits 3 with the snippet to paste when the options are not a literal", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "vite.config.ts": `const options = { host: "node" as const }\n${viteConfig("options")}`,
    })
    const before = await snapshot(root)

    const { exitCode, json } = await add(["kv", "--option", "driver=fs-lite", "--yes", "--no-install"], root)

    expect(exitCode).toBe(3)
    expect(json.error).toMatchObject({ code: "SETUP_CONFIG_MANUAL" })
    expect(json.error?.why).toContain("(dynamic-options)")
    expect(json.snippet).toBe(`kv: { driver: "fs-lite" },`)
    expect(await snapshot(root)).toEqual(before)
  })

  it("installs the owner packages with the package manager before it writes files", async () => {
    const calls: Array<{ args: string[], command: string, cwd?: string, stdout?: string }> = []
    const spawn: ViteHubCliSpawn = async (command, args, options) => {
      calls.push({ args, command, cwd: options?.cwd, stdout: options?.stdout })
      return { exitCode: 0 }
    }
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })

    const { exitCode, json } = await add(["database", "--yes"], root, spawn)

    expect(exitCode).toBe(0)
    expect(json.install).toEqual({ command: "pnpm add @vite-hub/database drizzle-orm && pnpm add -D drizzle-kit", devPackages: ["drizzle-kit"], packages: ["@vite-hub/database", "drizzle-orm"] })
    expect(calls).toEqual([
      { args: ["add", "@vite-hub/database", "drizzle-orm"], command: "pnpm", cwd: root, stdout: "stderr" },
      { args: ["add", "-D", "drizzle-kit"], command: "pnpm", cwd: root, stdout: "stderr" },
    ])
  })

  it("declares owner packages in the target manifest even when hoisted", async () => {
    const root = await createProject({
      "package.json": pnpmManifest,
      "node_modules/@vite-hub/database/package.json": "{}",
      "node_modules/drizzle-orm/package.json": "{}",
      "node_modules/drizzle-kit/package.json": "{}",
      "app/package.json": pnpmManifest,
      "app/vite.config.ts": viteConfig(`{ host: "node" }`),
    })
    const result = await add(["database", "--dry-run"], join(root, "app"))
    expect(result.exitCode).toBe(0)
    expect(result.json.install.packages).toEqual(["@vite-hub/database", "drizzle-orm"])
    expect(result.json.install.devPackages).toEqual(["drizzle-kit"])
  })

  it("uses target manifest declarations even before dependencies are installed", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ dependencies: { "@vite-hub/database": "*", "drizzle-orm": "*" }, devDependencies: { "drizzle-kit": "*" } }),
      "vite.config.ts": viteConfig(`{ host: "node" }`),
    })
    const result = await add(["database", "--dry-run"], root)
    expect(result.exitCode).toBe(0)
    expect(result.json.install).toEqual({ packages: [], devPackages: [] })
  })

  it("reports dependency mutations when a second install fails without writing starter or config files", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const config = await readFile(join(root, "vite.config.ts"), "utf8")
    let calls = 0
    const spawn: ViteHubCliSpawn = async () => {
      calls++
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "@vite-hub/database": "*", "drizzle-orm": "*" } }))
      await writeFile(join(root, "pnpm-lock.yaml"), `install ${calls}`)
      return { exitCode: calls === 1 ? 0 : 1 }
    }
    const result = await add(["database", "--name", "main", "--yes"], root, spawn)
    expect(calls).toBe(2)
    expect(result.exitCode).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_INSTALL_FAILED")
    expect(result.json.error?.fix).toContain("package manager may have changed")
    expect(await readFile(join(root, "package.json"), "utf8")).not.toBe(pnpmManifest)
    expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toBe("install 2")
    expect(await readFile(join(root, "vite.config.ts"), "utf8")).toBe(config)
    expect(Object.keys(await snapshot(root))).not.toContain("server/databases/main.ts")
  })

  it("changes no file when the install fails", async () => {
    const spawn: ViteHubCliSpawn = async () => ({ exitCode: 1 })
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })
    const before = await snapshot(root)

    const { exitCode, json } = await add(["schedule", "--option", "runtime.driver=process", "--name", "cleanup", "--yes"], root, spawn)

    expect(exitCode).toBe(1)
    expect(json.error).toMatchObject({ code: "SETUP_INSTALL_FAILED", message: "`pnpm add @vite-hub/schedule` exited with code 1." })
    expect(await snapshot(root)).toEqual(before)
  })

  it("says that the default Workflow runs inline on deno, and not when a provider is set", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "deno" }`) })

    const inline = await add(["workflow", "--dry-run"], root)
    expect(inline.json.nextSteps).toContainEqual(expect.stringMatching(/^Workflow on .* uses Vercel Workflow by default\. .*inline in the request process/u))
    expect(inline.json.install.packages).toEqual(["@vite-hub/workflow"])

    const durable = await add(["workflow", "--option", "workflow.provider=openworkflow", "--dry-run"], root)
    expect(durable.json.nextSteps.join("\n")).not.toContain("inline")
    // `@vite-hub/workflow` depends on OpenWorkflow, so the provider adds no package.
    expect(durable.json.install.packages).toEqual(["@vite-hub/workflow"])
  })

  it.each([
    [],
    ["workflow.sqlite.path=.data/workflows.db"],
    ["workflow.postgres.url=postgres://localhost/workflows"],
    ["workflow.worker.concurrency=4"],
  ])("uses OpenWorkflow on node without an inline warning (%s)", async (...options) => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig(`{ host: "node" }`) })

    const { exitCode, json } = await add(["workflow", ...options.flatMap(option => ["--option", option]), "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(json.install.packages).toEqual(["@vite-hub/workflow"])
    expect(json.nextSteps.join("\n")).not.toContain("inline")
  })

  it("says that the Vercel Workspace keeps files in memory until a Blob token is set", async () => {
    const root = await copyFixture("vercel")

    const memory = await runSetup<AddResult>(["add", "workspace", "--dry-run", "--json"], root)
    expect(memory.json.nextSteps).toContainEqual(expect.stringContaining("Workspace on vercel uses memory / Blob / GitHub by default. Process-local memory by default."))

    const blob = await runSetup<AddResult>(["add", "workspace", "--dry-run", "--json"], root, { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test" })
    expect(blob.json.nextSteps.join("\n")).not.toContain("memory")
  })

  it("points a Vercel Workflow starter to the durable native entry", async () => {
    const root = await copyFixture("vercel")

    const { json } = await add(["workflow", "--name", "onboard-user", "--dry-run"], root)

    expect(json.nextSteps).toContainEqual(expect.stringContaining("server/workflows/onboard-user.ts has no `native` entry"))
  })

  it.each([
    ["deno", "blob"],
    ["node-self-hosted", "blob.stores.default"],
  ])("installs the S3 SDK on %s for %s", async (fixture, option) => {
    const root = await copyFixture(fixture)

    const { exitCode, json } = await add(["blob", "--option", `${option}.driver=s3`, "--option", `${option}.bucket=app-assets`, "--dry-run"], root)

    expect(exitCode).toBe(0)
    expect(json.install.packages).toEqual(["@vite-hub/blob", "@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"])
  })

  it.each([
    ["", "server", "queues/jobs.cts"],
    ["", "server", "queues/jobs.cjs"],
    ['serverDir: "backend",', "backend", "queues/jobs.mjs"],
    ['rootDir: "app",', "app/server", "queues/jobs.cts"],
    ['rootDir: "app", serverDir: "backend",', "app/backend", "queues/jobs.cjs"],
    ['rootDir: "app", serverDir: "backend",', "app", "src/jobs.queue.mjs"],
  ])("rejects equivalent Nuxt Definitions without writing: %s %s/%s", async (options, serverDir, definition) => {
    const root = await createProject({
      [`${serverDir}/${definition}`]: "export default {}\n",
      "nuxt.config.ts": `export default defineNuxtConfig({ modules: ["vite-hub/nuxt"], ${options} vitehub: { host: "node" } })`,
      "package.json": pnpmManifest,
    })
    const before = await snapshot(root)
    const { exitCode, json } = await add(["queue", "--name", "jobs", "--no-install", "--yes"], root)
    expect(exitCode).toBe(3)
    expect(json.error?.code).toBe("SETUP_FILE_EXISTS")
    expect(await snapshot(root)).toEqual(before)
  })

  it.each(["cts", "cjs"])("rejects Vite suffix Definitions with .%s extensions", async (extension) => {
    const root = await createProject({
      [`src/jobs.queue.${extension}`]: "export default {}\n",
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig('{ host: "node" }'),
    })
    const before = await snapshot(root)
    expect((await add(["queue", "--name", "jobs", "--no-install", "--yes"], root)).exitCode).toBe(3)
    expect(await snapshot(root)).toEqual(before)
  })

  it.each([
    ["server/databases/main/index.ts", "main"],
    ["server/databases/team/main.ts", "team/main"],
  ])("writes the default Database beside the named Definition %s", async (definition, name) => {
    const root = await createProject({
      [definition]: `export default { name: ${JSON.stringify(name)} }\n`,
      "package.json": pnpmManifest,
      "vite.config.ts": viteConfig('{ host: "node" }'),
    })
    const { exitCode } = await add(["database", "--name", "default", "--no-install", "--yes"], root)

    expect(exitCode).toBe(0)
    expect(await readFile(join(root, "server/databases/default.ts"), "utf8")).toContain("defineDatabase({\n  schema: {")
  })

  it("names a named starter Database after its file", async () => {
    const root = await createProject({ "package.json": pnpmManifest, "vite.config.ts": viteConfig('{ host: "node" }') })
    expect((await add(["database", "--name", "analytics", "--no-install", "--yes"], root)).exitCode).toBe(0)
    expect(await readFile(join(root, "server/databases/analytics.ts"), "utf8")).toContain('defineDatabase({\n  name: "analytics",\n  schema: {')
  })

  it("refuses a starter that would be a second Definition of the same name", async () => {
    const root = await copyFixture("cloudflare")
    await writeFile(join(root, "src/welcome-email.queue.ts"), "export default {}\n")
    const before = await snapshot(root)

    for (const [args, file, starter] of [
      [["database", "--name", "default"], "src/database.ts", "server/databases/default.ts"],
      // The owner rejects a Named Database next to the Default one.
      [["database", "--name", "main"], "src/database.ts", "server/databases/main.ts"],
      [["queue", "--name", "welcome-email"], "src/welcome-email.queue.ts", "server/queues/welcome-email.ts"],
    ] as const) {
      const { exitCode, json } = await add([...args, "--no-install", "--yes"], root)
      expect(exitCode, args.join(" ")).toBe(3)
      expect(json.error, args.join(" ")).toMatchObject({ code: "SETUP_FILE_EXISTS", message: `${file} already defines a ${args[0] === "queue" ? "Queue" : "Database"} Definition that conflicts with ${starter}, so the build would reject both.` })
    }
    expect(await snapshot(root)).toEqual(before)
  })
})
