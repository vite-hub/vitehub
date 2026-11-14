import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { discoverSync, hubSync, renderSyncHandler, renderSyncTypes } from "../src/vite.ts"

import type { UserConfig } from "vite"

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-sync-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const imports = { runtime: "vite-hub/sync/runtime", operations: "vite-hub/sync/operations", database: "vite-hub/sync/database", databases: "@vite-hub/database/runtime/registry", auth: "vite-hub/auth/server" }

async function configure(root: string, options: Parameters<typeof hubSync>[0] = {}) {
  const plugin = hubSync(options)
  const config: UserConfig = { root }
  const handler = plugin.config
  if (!handler || typeof handler !== "object") throw new TypeError("Expected a config hook object.")
  await handler.handler.call({} as never, config, { command: "build", mode: "production" })
  return { plugin, config }
}

describe("discoverSync", () => {
  it("finds server/sync/<name> files, sorted, without declarations", () => {
    const root = app({ "server/sync/todos.ts": "", "server/sync/shopping-list.mjs": "", "server/sync/types.d.ts": "", "server/sync/nested/x.ts": "" })
    expect(discoverSync(root).map(definition => definition.name)).toEqual(["shopping-list", "todos"])
    expect(discoverSync(app({}))).toEqual([])
  })

  it("rejects names that are not a route segment, and duplicates", () => {
    expect(() => discoverSync(app({ "server/sync/My Todos.ts": "" }))).toThrow(expect.objectContaining({ code: "SYNC_INVALID_NAME" }))
    expect(() => discoverSync(app({ "server/sync/todos.ts": "", "server/sync/todos.mjs": "" }))).toThrow("Two files define the Sync name \"todos\"")
  })
})

describe("renderSyncHandler", () => {
  it("passes the Database registry, and the session only with Auth", () => {
    const definitions = [{ name: "todos", file: "/app/server/sync/todos.ts" }]
    const bare = renderSyncHandler(definitions, { imports })
    expect(bare).toContain("import { databases } from \"@vite-hub/database/runtime/registry\"")
    expect(bare).toContain("import sync0 from \"/app/server/sync/todos.ts\"")
    expect(bare).toContain("definitions: { \"todos\": sync0 }")
    expect(bare).not.toContain("useAuth")
    expect(renderSyncHandler(definitions, { imports, auth: true })).toContain("useAuth(request).api.getSession")
  })

  it("types useSync() names with the default export of each file", () => {
    expect(renderSyncTypes([{ name: "todos", file: "/app/server/sync/todos.ts" }])).toContain("\"todos\": typeof import(\"/app/server/sync/todos\").default")
  })
})

describe("hubSync", () => {
  it("adds one eager Nitro handler, the types, and the tables", async () => {
    const root = app({ "server/sync/todos.ts": "export default {}\n" })
    const { plugin, config } = await configure(root)
    const nitro: unknown = Reflect.get(config, "nitro")
    expect(Reflect.get(Object(nitro), "handlers")).toEqual(expect.arrayContaining([{ handler: join(root, ".vitehub/nitro/sync/handler.mjs"), lazy: false, route: "/api/_vitehub/sync/**" }]))
    expect(readFileSync(join(root, ".vitehub/types/sync.d.ts"), "utf8")).toContain("interface ViteHubSyncMap")
    expect(plugin.vitehub.databases({ projectRoot: root })).toEqual([expect.objectContaining({ dialect: "sqlite", name: "sync", tables: { syncChanges: "vitehub_sync_changes", syncMutations: "vitehub_sync_mutations", syncState: "vitehub_sync_state" } })])
  })

  it("does nothing without server/sync/, and removes old output", async () => {
    const root = app({ ".vitehub/nitro/sync/handler.mjs": "", ".vitehub/types/sync.d.ts": "" })
    const { plugin, config } = await configure(root)
    expect(Reflect.get(config, "nitro")).toBeUndefined()
    expect(existsSync(join(root, ".vitehub/nitro/sync"))).toBe(false)
    expect(existsSync(join(root, ".vitehub/types/sync.d.ts"))).toBe(false)
    expect(plugin.vitehub.databases({ projectRoot: root })).toEqual([])
  })

  it("fails the build when the Database is off", async () => {
    const root = app({ "server/sync/todos.ts": "export default {}\n" })
    await expect(configure(root, { database: false })).rejects.toMatchObject({ code: "SYNC_NO_DATABASE" })
  })
})
