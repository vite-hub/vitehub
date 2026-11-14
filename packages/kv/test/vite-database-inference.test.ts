import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveDBViteConfig } from "@vite-hub/database/config"

import { hubKV } from "../src/vite.ts"

import type { Plugin, ResolvedConfig } from "vite"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function createApp(dialect: "postgresql" | "sqlite", serverDir = "server"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-kv-inference-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  await mkdir(join(root, serverDir, "databases"), { recursive: true })
  await writeFile(join(root, serverDir, "databases", "default.ts"), [
    `import { defineDatabase } from "@vite-hub/database"`,
    `export default defineDatabase({ ${dialect === "postgresql" ? `dialect: "postgresql", ` : ""}schema: {} })`,
    ``,
  ].join("\n"))
  return root
}

type Hook<T extends unknown[], R> = { handler: (...args: T) => R }

/** The Database Vite plugin as KV sees it, with the configuration that the Database integration resolves. */
function databasePlugin(root: string, serverDirs?: string[]): Plugin {
  // SAFETY: KV reads only `name` and `api.getConfig()` of the Database plugin.
  return { name: "@vite-hub/database/vite", api: { getConfig: () => resolveDBViteConfig(undefined, root, { implicitDefault: true, serverDirs }) } } as Plugin
}

/** Runs the plugin as a Vite build does and returns the generated `#vitehub/kv/config` module. */
async function generatedConfig(root: string, plugins: Plugin[], options?: Parameters<typeof hubKV>[1]): Promise<string> {
  const plugin = hubKV(undefined, options)
  // SAFETY: The test passes the fields of a resolved Vite config that the KV plugin reads.
  const config = { command: "build", envDir: false, mode: "production", plugins, root } as unknown as ResolvedConfig
  await (plugin.configResolved as Hook<[ResolvedConfig], Promise<void>>).handler(config)
  // SAFETY: buildStart reads only the provider output catalog, which this test does not use.
  ;(plugin.buildStart as Hook<[], void>).handler.call({} as never)
  const resolveId = (plugin.resolveId as Hook<[string, string | undefined, { ssr: boolean }], { id: string } | string | undefined>).handler
  const id = resolveId("#vitehub/kv/config", undefined, { ssr: true })
  return String((plugin.load as Hook<[string, { ssr: boolean }], string | undefined>).handler(typeof id === "string" ? id : id!.id, { ssr: true }))
}

describe("KV driver inference in a build", () => {
  it("selects the database driver for a Postgres Default Database, and imports the app's databases", async () => {
    const root = await createApp("postgresql")
    const output = await generatedConfig(root, [databasePlugin(root)], { databaseImport: "@vite-hub/database/runtime/registry", hosting: "node-server" })

    expect(output).toContain(`"driver":"database"`)
    expect(output).toContain(`"inferred":true`)
    expect(output).toContain(`export const loadDatabases = () => import("@vite-hub/database/runtime/registry").then(module => module.databases);`)
  })

  it("reads the Database from the integration, also in server directories that KV does not know", async () => {
    const root = await createApp("postgresql", "src/server")
    const output = await generatedConfig(root, [databasePlugin(root, [join(root, "src/server")])], { hosting: "node-server" })

    expect(output).toContain(`"driver":"database"`)
  })

  it("keeps fs-lite for a SQLite Default Database", async () => {
    const root = await createApp("sqlite")
    const output = await generatedConfig(root, [databasePlugin(root)], { hosting: "node-server" })

    expect(output).toContain(`"driver":"fs-lite"`)
    expect(output).toContain("export const loadDatabases = undefined;")
  })

  it("keeps fs-lite when the Database plugin is not installed", async () => {
    const root = await createApp("postgresql")
    const output = await generatedConfig(root, [], { hosting: "node-server" })

    expect(output).toContain(`"driver":"fs-lite"`)
  })
})

describe("KV Redis env warning in a build", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("prints the fix once when the build has REDIS_URL and infers the Database", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const root = await createApp("postgresql")
    const plugin = hubKV(undefined, { hosting: "node-server" })
    // SAFETY: The test passes the fields of a resolved Vite config that the KV plugin reads.
    await (plugin.configResolved as Hook<[ResolvedConfig], Promise<void>>).handler({ command: "build", envDir: false, mode: "production", plugins: [databasePlugin(root)], root } as unknown as ResolvedConfig)
    // SAFETY: buildStart reads only the provider output catalog, which this test does not use.
    ;(plugin.buildStart as Hook<[], void>).handler.call({} as never)
    ;(plugin.buildStart as Hook<[], void>).handler.call({} as never)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toBe("[vitehub] The build has `REDIS_URL`, but KV does not select Redis on its own. The KV store \"default\" uses the table vitehub_kv of the Database \"default\". To keep KV in that Redis, set `kv: { driver: \"redis\" }`. To keep this store, set its `driver`.")
  })
})

describe("KV Nitro plugin", () => {
  async function nitroPlugins(hosting: string, options?: Parameters<typeof hubKV>[0]): Promise<string[] | undefined> {
    const root = await createApp("sqlite")
    const plugin = hubKV(options, { hosting })
    const nitro = { options: {} as { plugins?: string[] } }
    plugin.nitro.setup(nitro)
    // SAFETY: The test passes the fields of a resolved Vite config that the KV plugin reads.
    await (plugin.configResolved as Hook<[ResolvedConfig], Promise<void>>).handler({ command: "build", envDir: false, mode: "production", plugins: [], root } as unknown as ResolvedConfig)
    return nitro.options.plugins
  }

  it("disposes the stores on Nitro close when a store can use Redis", async () => {
    expect(await nitroPlugins("node-server")).toEqual([expect.stringMatching(/runtime[\\/]nitro-plugin\.(?:ts|js)$/)])
    expect(await nitroPlugins("node-server", { driver: "redis" })).toHaveLength(1)
  })

  it("adds nothing for stores without a connection", async () => {
    expect(await nitroPlugins("node-server", { driver: "fs-lite" })).toBeUndefined()
    expect(await nitroPlugins("cloudflare-module")).toBeUndefined()
  })
})
