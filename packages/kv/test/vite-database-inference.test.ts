import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { hubKv } from "../src/vite.ts"

import type { Plugin, ResolvedConfig } from "vite"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function createApp(dialect: "postgresql" | "sqlite"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-kv-inference-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  await mkdir(join(root, "server", "databases"), { recursive: true })
  await writeFile(join(root, "server", "databases", "config.ts"), [
    `import { defineDatabase } from "@vite-hub/database"`,
    `export default defineDatabase({ ${dialect === "postgresql" ? `dialect: "postgresql", ` : ""}schema: {} })`,
    ``,
  ].join("\n"))
  return root
}

type Hook<T extends unknown[], R> = { handler: (...args: T) => R }

/** Runs the plugin as a Vite build does and returns the generated `#vitehub/kv/config` module. */
async function generatedConfig(root: string, plugins: { name: string }[], options?: Parameters<typeof hubKv>[1]): Promise<string> {
  const plugin = hubKv(undefined, options)
  // SAFETY: The test passes the fields of a resolved Vite config that the KV plugin reads.
  const config = { command: "build", envDir: false, mode: "production", plugins, root } as unknown as ResolvedConfig
  await (plugin.configResolved as Hook<[ResolvedConfig], Promise<void>>).handler(config)
  const resolveId = (plugin.resolveId as Hook<[string, string | undefined, { ssr: boolean }], { id: string } | string | undefined>).handler
  const id = resolveId("#vitehub/kv/config", undefined, { ssr: true })
  return String((plugin.load as Hook<[string, { ssr: boolean }], string | undefined>).handler(typeof id === "string" ? id : id!.id, { ssr: true }))
}

const databasePlugin: Plugin = { name: "@vite-hub/database/vite" }

describe("KV driver inference in a build", () => {
  it("selects the database driver for a Postgres Default Database, and imports the app's databases", async () => {
    const root = await createApp("postgresql")
    const output = await generatedConfig(root, [databasePlugin], { databaseImport: "vite-hub/database/drizzle", hosting: "node-server" })

    expect(output).toContain(`"driver":"database"`)
    expect(output).toContain(`"inferred":true`)
    expect(output).toContain(`export const loadDatabases = () => import("vite-hub/database/drizzle").then(module => module.databases);`)
  })

  it("keeps fs-lite for a SQLite Default Database", async () => {
    const root = await createApp("sqlite")
    const output = await generatedConfig(root, [databasePlugin], { hosting: "node-server" })

    expect(output).toContain(`"driver":"fs-lite"`)
    expect(output).toContain("export const loadDatabases = undefined;")
  })

  it("keeps fs-lite when the Database plugin is not installed", async () => {
    const root = await createApp("postgresql")
    const output = await generatedConfig(root, [], { hosting: "node-server" })

    expect(output).toContain(`"driver":"fs-lite"`)
  })
})

describe("KV close plugin", () => {
  async function nitroPlugins(hosting: string, options?: Parameters<typeof hubKv>[0]): Promise<string[] | undefined> {
    const root = await createApp("sqlite")
    const plugin = hubKv(options, { hosting })
    const nitro = { options: {} as { plugins?: string[] } }
    plugin.nitro.setup(nitro)
    // SAFETY: The test passes the fields of a resolved Vite config that the KV plugin reads.
    await (plugin.configResolved as Hook<[ResolvedConfig], Promise<void>>).handler({ command: "build", envDir: false, mode: "production", plugins: [], root } as unknown as ResolvedConfig)
    return nitro.options.plugins
  }

  it("disposes the stores on Nitro close when a store can use Redis", async () => {
    expect(await nitroPlugins("node-server")).toEqual([expect.stringMatching(/runtime[\\/]nitro-close\.(?:ts|js)$/)])
    expect(await nitroPlugins("node-server", { driver: "redis" })).toHaveLength(1)
  })

  it("adds nothing for stores without a connection", async () => {
    expect(await nitroPlugins("node-server", { driver: "fs-lite" })).toBeUndefined()
    expect(await nitroPlugins("cloudflare-module")).toBeUndefined()
  })
})

