import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import type { Plugin } from "vite"
import { describe, expect, it, vi } from "vitest"
import { defaultDatabaseD1Binding, withComments, withConnectionsDatabase, withDataDir } from "../src/storage-config.ts"
import { vitehub } from "../src/index.ts"

import type { ViteHubOptions } from "../src/index.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

/** The generated Agent Invocations plugin, which installs the default journal with the Console on or off. */
async function generatedJournalPlugin(options: ViteHubOptions, command: "build" | "serve", files: Record<string, string> = {}): Promise<{ info: string[], plugin: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-storage-journal-"))
  try {
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), contents)
    }
    const plugin = vitehub(options)
      .find((plugin): plugin is Plugin => !!plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "vite-hub/agent-invocations")
    const config = plugin?.config
    const configResolved = plugin?.configResolved
    if (!config || !configResolved) throw new TypeError("Expected Agent Invocations config hooks.")
    await Reflect.apply("handler" in config ? config.handler : config, {}, [{ root, [VITEHUB_SERVER_DIRS]: [join(root, "server")] }, { command, mode: command === "build" ? "production" : "development" }])
    const info: string[] = []
    await Reflect.apply("handler" in configResolved ? configResolved.handler : configResolved, {}, [{ root, logger: { info: (message: string) => info.push(message), warn: vi.fn() } }])
    return { info, plugin: await readFile(join(root, ".vitehub/nitro/agent/invocations.mjs"), "utf8") }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("Node storage defaults", () => {
  it("puts enabled local stores under the explicit directory", () => {
    const dataDir = "/var/lib/app data"
    expect(withDataDir({ preset: "node", dataDir, agent: true, console: { auth: false }, kv: true, blob: true, workspace: true })).toMatchObject({
      agent: { providers: { state: { provider: "libsql", url: pathToFileURL(join(dataDir, "agent-state.sqlite")).href } } },
      console: { auth: false },
      kv: { driver: "fs-lite", base: join(dataDir, "kv") },
      blob: { driver: "fs", base: join(dataDir, "blob") },
      workspace: { root: join(dataDir, "workspaces") },
    })
  })

  it("puts the inline Console Auth database under the explicit directory", () => {
    const dataDir = "/var/lib/app data"
    const auth = { provider: "github" as const, org: "acme" }
    expect(withDataDir({ preset: "node", dataDir, console: { auth } }).console).toMatchObject({
      auth: { ...auth, databasePath: join(dataDir, "console-auth.sqlite") },
    })
    expect(withDataDir({ preset: "node", dataDir, console: { auth: { ...auth, databasePath: "/data/auth.sqlite" } } }).console)
      .toMatchObject({ auth: { databasePath: "/data/auth.sqlite" } })
    expect(withDataDir({ preset: "node", dataDir, console: { auth: {} } }).console).toMatchObject({ auth: {} })
    const accessAuth = { provider: "cloudflare-access" as const, audience: "aud", teamDomain: "acme.cloudflareaccess.com" }
    expect(withDataDir({ preset: "node", dataDir, console: { auth: accessAuth } }).console).toHaveProperty("auth", accessAuth)
  })

  it.each(["serve", "build"] as const)("keeps the default Agent journal under dataDir during %s, with the Console on or off", async (command) => {
    const dataDir = "/var/lib/app data"
    const databaseUrl = JSON.stringify(pathToFileURL(join(dataDir, "agent-invocations.sqlite")).href)
    for (const options of [{ preset: "node", dataDir, agent: true }, { preset: "node", dataDir, agent: true, console: { auth: false } }] satisfies ViteHubOptions[]) {
      const { plugin } = await generatedJournalPlugin(options, command)
      expect(plugin).toContain(`default: {"databaseUrl":${databaseUrl}}`)
      expect(plugin).toContain("journal: { projectRoot: ")
    }
    const explicit = withDataDir({ preset: "node", dataDir, agent: { invocations: { databaseUrl: "libsql://journal.example.com", retention: { maxAge: "14d" } } } })
    expect(explicit.agent).toEqual({ invocations: { databaseUrl: "libsql://journal.example.com", retention: { maxAge: "14d" } }, providers: { state: { provider: "libsql", url: pathToFileURL(join(dataDir, "agent-state.sqlite")).href } } })
    expect(withDataDir({ preset: "node", dataDir, agent: { invocations: "memory" } }).agent).toMatchObject({ invocations: "memory" })
  })

  it("preserves explicit storage and disabled Agents", () => {
    const options = {
      preset: "node" as const,
      dataDir: "/var/lib/app",
      agent: false as const,
      console: { auth: false as const, authorize: hostManagedAuthorize },
      kv: { driver: "upstash" as const, url: "https://kv.example.com", token: "fixture" },
      blob: { driver: "fs" as const, base: "/existing/uploads" },
      workspace: { root: "/existing/workspaces" },
    }
    expect(withDataDir(options)).toEqual(options)
  })

  it("keeps remote agent state and does not enable disabled services", () => {
    const options = { preset: "node" as const, dataDir: "/var/lib/app", agent: { invocations: false as const, providers: { state: { provider: "libsql" as const, url: "libsql://state.example.com" } } }, kv: false as const, blob: false as const }
    expect(withDataDir(options)).toEqual(options)
  })

  it("gives named local stores separate directories and preserves remote stores", () => {
    const result = withDataDir({ preset: "node", dataDir: "/var/lib/app", kv: { stores: { first: { driver: "fs-lite" }, second: { driver: "fs-lite" } } }, blob: { stores: { uploads: { driver: "fs" }, external: { driver: "vercel-blob", token: "fixture" } } } })
    expect(result.kv).toEqual({ stores: { first: { driver: "fs-lite", base: "/var/lib/app/kv/first" }, second: { driver: "fs-lite", base: "/var/lib/app/kv/second" } } })
    expect(result.blob).toEqual({ stores: { uploads: { driver: "fs", base: "/var/lib/app/blob/uploads" }, external: { driver: "vercel-blob", token: "fixture" } } })
  })

  it("ignores inherited named stores when applying local defaults", () => {
    const kv = Object.assign(Object.create({ stores: { inherited: { driver: "fs-lite" as const } } }), {
      driver: "upstash" as const,
      url: "https://kv.example.com",
      token: "token",
    })
    const blob = Object.assign(Object.create({ stores: { inherited: { driver: "fs" as const } } }), {
      driver: "vercel-blob" as const,
      token: "token",
    })
    const result = withDataDir({ preset: "node", dataDir: "/tmp/app", kv, blob } as ViteHubOptions)
    expect(result.kv).toEqual({ driver: "upstash", url: "https://kv.example.com", token: "token" })
    expect(result.blob).toEqual({ driver: "vercel-blob", token: "token" })
  })

  it("rejects local storage on hosted ephemeral presets through the public API", () => {
    for (const preset of ["cloudflare", "vercel", "netlify", "deno"] as const) {
      expect(() => vitehub({ preset, dataDir: "/data" })).toThrow("dataDir requires the node preset")
    }
    expect(() => vitehub({ preset: "node", dataDir: "  " })).toThrow("non-empty")
  })

  it("rejects malformed dataDir values with the configuration diagnostic", () => {
    for (const preset of ["node", "cloudflare", "vercel", "netlify", "deno"] as const) {
      for (const dataDir of [null, 1, {}, [], "", "  "]) {
        expect(() => vitehub({ preset, dataDir } as unknown as ViteHubOptions)).toThrow("non-empty directory path")
      }
    }
  })

  it("keeps existing defaults when no directory is supplied", () => {
    const options = { preset: "node" as const, agent: true }
    expect(withDataDir(options)).toBe(options)
  })
})

describe("Default Agent journal host defaults", () => {
  // The Console is off: the default journal does not depend on it.
  const cloudflare = { preset: "cloudflare", agent: true, database: { driver: "d1", binding: "DB" } } satisfies ViteHubOptions

  it("does not select an unprovisioned explicit D1 binding", async () => {
    const { info, plugin } = await generatedJournalPlugin(cloudflare, "build")
    expect(plugin).not.toContain("cloudflare:workers")
    expect(info).toEqual([])
  })

  it("reads the D1 binding from the default Database Definition", async () => {
    const definition = `import { defineDatabase } from "vite-hub/database"\nexport default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n`
    const { plugin } = await generatedJournalPlugin({ ...cloudflare, database: true }, "build", { "server/databases/config.ts": definition })
    expect(plugin).toContain(`d1: { binding: "APP_DB",`)
    const withoutDefinition = await generatedJournalPlugin({ ...cloudflare, database: true }, "build")
    expect(withoutDefinition.plugin).not.toContain("cloudflare:workers")
  })

  it("reads the D1 binding from the only named Database and skips ambiguous ones", async () => {
    const named = (name: string, binding: string) => `export default defineDatabase({ name: "${name}", cloudflare: { binding: "${binding}", databaseName: "${name}" }, schema: {} })\n`
    const only = await generatedJournalPlugin({ ...cloudflare, database: true }, "build", { "server/databases/app/config.ts": named("app", "APP_DB") })
    expect(only.plugin).toContain('d1: { binding: "APP_DB",')
    const ambiguous = await generatedJournalPlugin({ ...cloudflare, database: true }, "build", {
      "server/databases/app/config.ts": named("app", "APP_DB"),
      "server/databases/audit/config.ts": named("audit", "AUDIT_DB"),
    })
    expect(ambiguous.plugin).not.toContain("cloudflare:workers")
  })

  it("reads the D1 binding from the Database project root", async () => {
    const { plugin } = await generatedJournalPlugin({ ...cloudflare, database: { projectRoot: "data" } }, "build", {
      "server/databases/config.ts": 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n',
      "data/server/databases/config.ts": 'export default defineDatabase({ cloudflare: { binding: "DATA_DB", databaseName: "data" }, schema: {} })\n',
    })
    expect(plugin).toContain('d1: { binding: "DATA_DB",')
    expect(plugin).not.toContain('d1: { binding: "APP_DB",')
  })

  it.each([
    ['cloudflare: { binding: "APP_DB", databaseName: "app" },', "APP_DB"],
    ['cloudflare: { databaseName: "app" },', "JOURNAL_DB"],
    ["", "JOURNAL_DB"],
  ])("selects the effective D1 binding with Definition config %s", async (config, binding) => {
    const { plugin } = await generatedJournalPlugin({ ...cloudflare, database: { driver: "d1", binding: "JOURNAL_DB" } }, "build", {
      "server/databases/config.ts": `export default defineDatabase({ ${config} schema: {} })\n`,
    })
    expect(plugin).toContain(`d1: { binding: "${binding}",`)
  })

  it("keeps the local libSQL journal during Cloudflare development", async () => {
    const { info, plugin } = await generatedJournalPlugin(cloudflare, "serve")
    expect(plugin).toContain("journal: { projectRoot: ")
    expect(plugin).not.toContain("cloudflare:workers")
    expect(info).toEqual([])
  })

  it("installs the same D1 journal with the Console on", async () => {
    const definition = 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n'
    const off = await generatedJournalPlugin({ ...cloudflare, database: true }, "build", { "server/databases/config.ts": definition })
    const on = await generatedJournalPlugin({ ...cloudflare, database: true, console: { auth: false, authorize: hostManagedAuthorize } }, "build", { "server/databases/config.ts": definition })
    expect(off.plugin).toContain('d1: { binding: "APP_DB",')
    expect(off.info).toEqual(["[vitehub] Agent Invocation journal: D1 binding APP_DB, table vitehub_agent_invocations. The journal creates the table on first use."])
    expect(on.plugin.replace(/"\/[^"]*"/g, "ROOT")).toBe(off.plugin.replace(/"\/[^"]*"/g, "ROOT"))
  })

  it("keeps libSQL on Node and when the journal database URL is explicit", async () => {
    const node = await generatedJournalPlugin({ ...cloudflare, preset: "node" }, "build")
    expect(node.plugin).not.toContain("cloudflare:workers")
    const explicit = await generatedJournalPlugin({ ...cloudflare, agent: { invocations: { databaseUrl: "libsql://journal.example.com" } }, database: true }, "build", {
      "server/databases/config.ts": 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n',
    })
    expect(explicit.plugin).toContain(`"databaseUrl":"libsql://journal.example.com"`)
    expect(explicit.plugin).not.toContain("cloudflare:workers")
  })

  it("fails the build for the removed Console journal options", () => {
    for (const key of ["databaseUrl", "observations", "retention"]) {
      expect(() => vitehub({ preset: "node", agent: true, console: { auth: false, [key]: {} } as ViteHubOptions["console"] }))
        .toThrow(expect.objectContaining({ code: "VITE_HUB_B0020", message: expect.stringContaining(`agent: { invocations: { ${key} } }`) }))
    }
  })

  it("resolves the D1 binding from the Database options", () => {
    expect(defaultDatabaseD1Binding("cloudflare", { driver: "d1" })).toBeUndefined()
    expect(defaultDatabaseD1Binding("cloudflare", { driver: "d1", binding: " JOURNAL " })).toBeUndefined()
    expect(defaultDatabaseD1Binding("cloudflare", true)).toBeUndefined()
    expect(defaultDatabaseD1Binding("cloudflare", { connection: { url: "libsql://db.example.com" } })).toBeUndefined()
    expect(defaultDatabaseD1Binding("vercel", { driver: "d1" })).toBeUndefined()
  })
})

describe("Connections database default", () => {
  // SAFETY: vitehub() returns a flat list of concrete plugins in these tests.
  const pluginNames = (options: ViteHubOptions) => (vitehub(options) as Plugin[]).map(plugin => plugin.name)

  it("enables database when connections is set and database is unset", () => {
    expect(withConnectionsDatabase({ connections: true, preset: "node" }).database).toBe(true)
    expect(pluginNames({ connections: true, preset: "node" })).toEqual(expect.arrayContaining(["@vite-hub/connections/vite", "@vite-hub/database/vite"]))
  })

  it.each(["users", "billing/archive", "audit.logs", "1users"])("passes the %s Database that connections.database names to Connections", (database) => {
    const connections = (vitehub({ connections: { database }, preset: "node" }) as Array<Plugin & { vitehub?: { databases?: () => unknown } }>)
      .find(plugin => plugin.name === "@vite-hub/connections/vite")
    expect(connections?.vitehub?.databases?.()).toEqual([expect.objectContaining({ database, name: "connections" })])
  })

  it("rejects an explicitly empty connections.database instead of selecting default", () => {
    expect(() => vitehub({ connections: { database: "" }, preset: "node" })).toThrow("connections.database must be a Database name")
  })

  it("keeps configured database options", () => {
    const database = { connection: { url: "file:/data/database/sqlite.db" } }
    expect(withConnectionsDatabase({ connections: true, database, preset: "node" }).database).toBe(database)
    expect(withConnectionsDatabase({ preset: "node" }).database).toBeUndefined()
  })

  it("turns Comments and the Database on with the Console, unless comments: false", () => {
    expect(withComments({ preset: "node", console: { auth: false } })).toMatchObject({ comments: true, database: true })
    expect(withComments({ preset: "node", console: { auth: false }, comments: { overlay: false } })).toMatchObject({ comments: { overlay: false }, database: true })
    expect(withComments({ preset: "node", console: { auth: false }, comments: false })).toEqual({ preset: "node", console: { auth: false }, comments: false })
    expect(withComments({ preset: "node", console: { auth: false }, comments: false, database: false })).toMatchObject({ comments: false, database: false })
    expect(withComments({ preset: "node" })).toEqual({ preset: "node" })
  })

  it("installs Comments with the Console, and leaves it out with comments: false", () => {
    const names = (options: ViteHubOptions) => vitehub(options).flat(3).flatMap(plugin => plugin && typeof plugin === "object" && "name" in plugin ? [plugin.name] : [])
    const console = { auth: false, authorize: hostManagedAuthorize } as const
    expect(names({ preset: "node", console })).toContain("@vite-hub/comments/vite")
    const off = names({ preset: "node", console, comments: false })
    expect(off).not.toContain("@vite-hub/comments/vite")
    expect(off).toContain("vite-hub/comments-off")
  })

  it("fails the build for server/comments.ts with comments: false", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-comments-off-"))
    try {
      await mkdir(join(root, "server"))
      await writeFile(join(root, "server/comments.ts"), "export default defineComments()\n")
      const plugin = vitehub({ preset: "node", comments: false }).flat(3).find((option): option is Plugin => option !== null && typeof option === "object" && "name" in option && option.name === "vite-hub/comments-off")
      const hook = plugin?.configResolved
      if (!hook) throw new TypeError("Expected the comments-off plugin.")
      expect(() => Reflect.apply("handler" in hook ? hook.handler : hook, {}, [{ root }])).toThrow(expect.objectContaining({ code: "VITE_HUB_B0019" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("fails when Comments is on and database is false", () => {
    expect(() => vitehub({ console: { auth: false, authorize: hostManagedAuthorize }, database: false, preset: "node" })).toThrow(expect.objectContaining({ code: "VITE_HUB_B0018" }))
    expect(() => vitehub({ comments: true, database: false, preset: "node" })).toThrow(expect.objectContaining({ code: "VITE_HUB_B0018" }))
    expect(() => vitehub({ console: { auth: false, authorize: hostManagedAuthorize }, comments: false, database: false, preset: "node" })).not.toThrow()
  })

  it("fails when connections is set and database is false", () => {
    expect(() => vitehub({ connections: true, database: false, preset: "node" })).toThrow(expect.objectContaining({ code: "VITE_HUB_R0124" }))
  })

  it("reads the D1 binding of the implicit default Database on Cloudflare", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-connections-d1-"))
    try {
      const database = { binding: "APP_DB", databaseId: "app-id", databaseName: "app", driver: "d1" as const }
      expect(defaultDatabaseD1Binding("cloudflare", database, { implicitDefault: true, root })).toBe("APP_DB")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
