import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { hubDatabase } from "../src/nuxt.ts"

const tmp = await mkdtemp(join(process.cwd(), ".vitest-nuxt-content-"))
afterAll(async () => await rm(tmp, { force: true, recursive: true }))

let fixtureId = 0

async function createApp(definition: string, options: { content?: Record<string, unknown>, dev?: boolean, preset?: string, modules?: unknown[], runtimeDatabase?: Record<string, unknown> } = {}) {
  const rootDir = join(tmp, `app-${fixtureId++}`)
  await mkdir(join(rootDir, "server/databases"), { recursive: true })
  await writeFile(join(rootDir, "package.json"), '{"private":true,"type":"module"}')
  await writeFile(join(rootDir, "server/databases/default.ts"), `import { defineDatabase } from '@vite-hub/database'\nexport default defineDatabase(${definition})\n`)
  const hooks: Record<string, Array<(value: Record<string, unknown>) => Promise<void> | void>> = {}
  const nuxt = {
    hook(name: string, callback: (value: Record<string, unknown>) => Promise<void> | void) {
      (hooks[name] ||= []).push(callback)
    },
    options: {
      dev: options.dev ?? false,
      modules: options.modules ?? ["@nuxt/content"],
      rootDir,
      vite: {},
      ...(options.content ? { content: options.content } : {}),
      ...(options.preset ? { nitro: { preset: options.preset } } : {}),
    } as Record<string, unknown>,
  }
  const module = hubDatabase()
  const dependencies = module.getModuleDependencies(nuxt)
  await module(undefined, nuxt)
  const nitroConfig: Record<string, unknown> = {
    ...(options.preset ? { preset: options.preset } : {}),
    ...(options.runtimeDatabase ? { runtimeConfig: { content: { database: options.runtimeDatabase } } } : {}),
  }
  for (const callback of hooks["nitro:config"] ?? []) await callback(nitroConfig)
  return { dependencies, nitroConfig, options: nuxt.options, rootDir }
}

function runtimeContentDatabase(nitroConfig: Record<string, unknown>) {
  return (nitroConfig.runtimeConfig as { content?: { database?: unknown } } | undefined)?.content?.database
}

describe("Nuxt Content database from the default Database Definition", () => {
  it("passes a Postgres URL from the environment without building it in", async () => {
    const { dependencies, nitroConfig, options, rootDir } = await createApp("{ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} }")
    // Nuxt applies dependency defaults before any module runs, so Content sees them in any module order.
    expect(dependencies).toEqual({ "@nuxt/content": { defaults: { database: { type: "postgresql", url: "" } } } })
    expect(options.content).toEqual({ database: { type: "postgresql", url: "" } })
    expect(runtimeContentDatabase(nitroConfig)).toEqual({ type: "postgresql", url: "" })
    const plugin = await readFile(join(rootDir, ".vitehub/nitro/database/content-database.ts"), "utf8")
    expect(plugin).toContain(`database.url ||= process.env["DATABASE_URL"]`)
    expect(nitroConfig.plugins).toContain(join(rootDir, ".vitehub/nitro/database/content-database.ts"))
  })

  it("passes a libSQL URL and auth token from the environment", async () => {
    const { nitroConfig, options, rootDir } = await createApp("{ connection: { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }, schema: {} }")
    expect(options.content).toEqual({ database: { type: "libsql", url: "", authToken: "" } })
    expect(runtimeContentDatabase(nitroConfig)).toEqual({ type: "libsql", url: "", authToken: "" })
    const plugin = await readFile(join(rootDir, ".vitehub/nitro/database/content-database.ts"), "utf8")
    expect(plugin).toContain(`database.url ||= process.env["TURSO_DATABASE_URL"]`)
    expect(plugin).toContain(`database.authToken ||= process.env["TURSO_AUTH_TOKEN"]`)
  })

  it("keeps a static libSQL URL as it is", async () => {
    const { options } = await createApp("{ connection: { url: 'libsql://app.turso.io' }, schema: {} }")
    expect(options.content).toEqual({ database: { type: "libsql", url: "libsql://app.turso.io" } })
  })

  it("leaves Content on its own SQLite file for a local SQLite Database", async () => {
    const { dependencies, nitroConfig, options } = await createApp("{ schema: {} }")
    expect(dependencies).toEqual({})
    expect(options.content).toBeUndefined()
    expect(runtimeContentDatabase(nitroConfig)).toBeUndefined()
  })

  it("leaves Content alone in development, where it reads its local SQLite file", async () => {
    const { options } = await createApp("{ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} }", { dev: true })
    expect(options.content).toBeUndefined()
  })

  it("installs the runtime plugin when the dependency default already set content.database", async () => {
    const { nitroConfig } = await createApp("{ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} }", { content: { database: { type: "postgresql", url: "" } } })
    expect(runtimeContentDatabase(nitroConfig)).toEqual({ type: "postgresql", url: "" })
    expect(nitroConfig.plugins).toHaveLength(1)
  })

  it("keeps an explicit content.database", async () => {
    const content = { database: { type: "sqlite", filename: "content.sqlite" } }
    const { nitroConfig, options } = await createApp("{ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} }", { content })
    expect(options.content).toEqual({ database: { type: "sqlite", filename: "content.sqlite" } })
    expect(runtimeContentDatabase(nitroConfig)).toBeUndefined()
  })

  it.each(["before", "after"])("keeps an explicit tuple database when Content is %s ViteHub", async (order) => {
    const database = { type: "postgresql", url: "postgres://content-host/content" }
    const contentModule = ["@nuxt/content", { database }]
    const modules = order === "before" ? [contentModule, "vite-hub/nuxt"] : ["vite-hub/nuxt", contentModule]
    const { dependencies, nitroConfig, options, rootDir } = await createApp("{ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} }", {
      modules,
      runtimeDatabase: database,
    })
    expect(dependencies).toEqual({})
    expect(options.content).toBeUndefined()
    expect(runtimeContentDatabase(nitroConfig)).toEqual(database)
    expect(nitroConfig.plugins ?? []).toEqual([])
    await expect(readFile(join(rootDir, ".vitehub/nitro/database/content-database.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not map Postgres on Cloudflare, where Content keeps one client across requests", async () => {
    await expect(createApp("{ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} }", { preset: "cloudflare_module" }))
      .rejects.toThrow("Nuxt Content on Cloudflare requires")
  })
})
