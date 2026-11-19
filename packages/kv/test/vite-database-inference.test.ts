import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveDBViteConfig } from "@vite-hub/database/config"
import { VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

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

  it("reports the hint once when the build has REDIS_URL and infers the Database", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379")
    const warn = vi.fn()
    const root = await createApp("postgresql")
    const frontend = join(root, "frontend")
    await mkdir(frontend)
    await writeFile(join(frontend, "package.json"), "{}")
    const plugin = hubKV(undefined, { hosting: "node-server" })
    // SAFETY: The test passes the fields of a resolved Vite config that the KV plugin reads.
    await (plugin.configResolved as Hook<[ResolvedConfig], Promise<void>>).handler({ command: "build", envDir: false, logger: { warn }, mode: "production", plugins: [databasePlugin(root)], root: frontend, [VITEHUB_PROJECT_ROOT]: root } as unknown as ResolvedConfig)
    // SAFETY: buildStart reads only the provider output catalog, which this test does not use.
    ;(plugin.buildStart as Hook<[], void>).handler.call({} as never)
    ;(plugin.buildStart as Hook<[], void>).handler.call({} as never)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain("The build has `REDIS_URL`, but KV does not select Redis on its own. The KV store \"default\" uses the table vitehub_kv of the Database \"default\".")
    const report = JSON.parse(await readFile(join(root, ".vitehub/hints.json"), "utf8"))
    await expect(readFile(join(frontend, ".vitehub/hints.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(report.hints).toEqual([{
      code: "KV_REDIS_URL_UNUSED",
      why: "The build has `REDIS_URL`, but KV does not select Redis on its own. The KV store \"default\" uses the table vitehub_kv of the Database \"default\".",
      fix: "To keep KV in that Redis, set `kv: { driver: \"redis\" }`. To keep this store, set its `driver`.",
      docs: "https://vitehub.dev/docs/kv/diagnostics/kv_redis_url_unused",
    }])
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
