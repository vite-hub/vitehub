import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import type { Plugin } from "vite"
import { describe, expect, it } from "vitest"
import { consoleD1Binding, resolveConsoleJournal, withDataDir } from "../src/storage-config.ts"
import { vitehub } from "../src/index.ts"

import type { ViteHubOptions } from "../src/index.ts"

async function generatedConsolePlugin(options: ViteHubOptions, command: "build" | "serve", files: Record<string, string> = {}): Promise<{ info: string[], plugin: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-storage-journal-"))
  try {
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), contents)
    }
    const plugin = vitehub(options)
      .find((plugin): plugin is Plugin => !!plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "vite-hub/console")
    const config = plugin?.config
    const configResolved = plugin?.configResolved
    if (!config || !configResolved) throw new TypeError("Expected Console config hooks.")
    await Reflect.apply("handler" in config ? config.handler : config, {}, [{ root, [VITEHUB_SERVER_DIRS]: [join(root, "server")] }, { command, mode: command === "build" ? "production" : "development" }])
    const info: string[] = []
    await Reflect.apply("handler" in configResolved ? configResolved.handler : configResolved, {}, [{ root, logger: { info: (message: string) => info.push(message) } }])
    return { info, plugin: await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8") }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("Node storage defaults", () => {
  it("puts enabled local stores under the explicit directory", () => {
    const dataDir = "/var/lib/app data"
    expect(withDataDir({ preset: "node", dataDir, agent: true, console: true, kv: true, blob: true, workspace: true })).toMatchObject({
      agent: { providers: { state: { provider: "libsql", url: pathToFileURL(join(dataDir, "agent-state.sqlite")).href } } },
      console: true,
      kv: { driver: "fs-lite", base: join(dataDir, "kv") },
      blob: { driver: "fs", base: join(dataDir, "blob") },
      workspace: { root: join(dataDir, "workspaces") },
    })
  })

  it.each(["serve", "build"] as const)("preserves Vite Console shorthand with dataDir during %s", async (command) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-storage-console-"))
    try {
      const dataDir = join(root, "persistent data")
      const plugin = vitehub({ preset: "node", dataDir, agent: true, console: true })
        .find((plugin): plugin is Plugin => !!plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "vite-hub/console")
      const hook = plugin?.config
      if (!hook) throw new TypeError("Expected a Console config hook.")
      const handler = "handler" in hook ? hook.handler : hook
      const configure = Reflect.apply(handler, {}, [{ root }, { command, mode: command === "build" ? "production" : "development" }])
      if (command === "build") {
        await expect(configure).rejects.toThrow("console: true is development-only")
      }
      else {
        await configure
        const generated = await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
        expect(generated).toContain("invoke: true")
        expect(generated).toContain(`databaseUrl: ${JSON.stringify(pathToFileURL(join(dataDir, "console.sqlite")).href)}`)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves explicit storage and disabled Agents", () => {
    const options = {
      preset: "node" as const,
      dataDir: "/var/lib/app",
      agent: false as const,
      console: { exposure: "host-managed" as const, databaseUrl: "libsql://journal.example.com" },
      kv: { driver: "upstash" as const, url: "https://kv.example.com", token: "fixture" },
      blob: { driver: "fs" as const, base: "/existing/uploads" },
      workspace: { root: "/existing/workspaces" },
    }
    expect(withDataDir(options)).toEqual(options)
  })

  it("keeps remote agent state and does not enable disabled services", () => {
    const options = { preset: "node" as const, dataDir: "/var/lib/app", agent: { providers: { state: { provider: "libsql" as const, url: "libsql://state.example.com" } } }, kv: false as const, blob: false as const }
    expect(withDataDir(options)).toEqual(options)
  })

  it("gives named local stores separate directories and preserves remote stores", () => {
    const result = withDataDir({ preset: "node", dataDir: "/var/lib/app", kv: { stores: { first: { driver: "fs-lite" }, second: { driver: "fs-lite" } } }, blob: { stores: { uploads: { driver: "fs" }, external: { driver: "vercel-blob", token: "fixture" } } } })
    expect(result.kv).toEqual({ stores: { first: { driver: "fs-lite", base: "/var/lib/app/kv/first" }, second: { driver: "fs-lite", base: "/var/lib/app/kv/second" } } })
    expect(result.blob).toEqual({ stores: { uploads: { driver: "fs", base: "/var/lib/app/blob/uploads" }, external: { driver: "vercel-blob", token: "fixture" } } })
  })

  it("rejects local storage on hosted ephemeral presets through the public API", () => {
    for (const preset of ["cloudflare", "vercel", "netlify", "deno"] as const) {
      expect(() => vitehub({ preset, dataDir: "/data" })).toThrow("dataDir requires the node preset")
    }
    expect(() => vitehub({ preset: "node", dataDir: "  " })).toThrow("non-empty")
  })

  it("keeps existing defaults when no directory is supplied", () => {
    const options = { preset: "node" as const, agent: true }
    expect(withDataDir(options)).toBe(options)
  })
})

describe("Console journal host defaults", () => {
  const cloudflare = { preset: "cloudflare", agent: true, console: { exposure: "host-managed" }, database: { driver: "d1", binding: "DB" } } satisfies ViteHubOptions

  it("does not select an unprovisioned explicit D1 binding", async () => {
    const { info, plugin } = await generatedConsolePlugin(cloudflare, "build")
    expect(plugin).not.toContain("cloudflare:workers")
    expect(info).toEqual([])
  })

  it("reads the D1 binding from the default Database Definition", async () => {
    const definition = `import { defineDatabase } from "vite-hub/database"\nexport default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n`
    const { plugin } = await generatedConsolePlugin({ ...cloudflare, database: true }, "build", { "server/databases/config.ts": definition })
    expect(plugin).toContain(`d1: { binding: "APP_DB",`)
    const withoutDefinition = await generatedConsolePlugin({ ...cloudflare, database: true }, "build")
    expect(withoutDefinition.plugin).not.toContain("cloudflare:workers")
  })

  it("reads the D1 binding from the Database project root", async () => {
    const { plugin } = await generatedConsolePlugin({ ...cloudflare, database: { projectRoot: "data" } }, "build", {
      "server/databases/config.ts": 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n',
      "data/server/databases/config.ts": 'export default defineDatabase({ cloudflare: { binding: "DATA_DB", databaseName: "data" }, schema: {} })\n',
    })
    expect(plugin).toContain('d1: { binding: "DATA_DB",')
    expect(plugin).not.toContain('d1: { binding: "APP_DB",')
  })

  it.each([
    ['cloudflare: { binding: "APP_DB", databaseName: "app" },', "APP_DB"],
    ['cloudflare: { databaseName: "app" },', "DB"],
    ["", "JOURNAL_DB"],
  ])("selects the effective D1 binding with Definition config %s", async (config, binding) => {
    const { plugin } = await generatedConsolePlugin({ ...cloudflare, database: { driver: "d1", binding: "JOURNAL_DB" } }, "build", {
      "server/databases/config.ts": `export default defineDatabase({ ${config} schema: {} })\n`,
    })
    expect(plugin).toContain(`d1: { binding: "${binding}",`)
  })

  it("keeps the local libSQL journal during Cloudflare development", async () => {
    const { info, plugin } = await generatedConsolePlugin(cloudflare, "serve")
    expect(plugin).toContain("installConsoleAgentDefinitions(")
    expect(plugin).not.toContain("cloudflare:workers")
    expect(info).toEqual([])
  })

  it("keeps libSQL on Node and when the Console database URL is explicit", async () => {
    const node = await generatedConsolePlugin({ ...cloudflare, preset: "node" }, "build")
    expect(node.plugin).not.toContain("cloudflare:workers")
    const explicit = await generatedConsolePlugin({ ...cloudflare, console: { exposure: "host-managed", databaseUrl: "libsql://journal.example.com" } }, "build")
    expect(explicit.plugin).toContain(`databaseUrl: "libsql://journal.example.com"`)
    expect(explicit.plugin).not.toContain("cloudflare:workers")
  })

  it("resolves the D1 binding from the Database options", () => {
    expect(consoleD1Binding("cloudflare", { driver: "d1" })).toBeUndefined()
    expect(consoleD1Binding("cloudflare", { driver: "d1", binding: " JOURNAL " })).toBeUndefined()
    expect(consoleD1Binding("cloudflare", true)).toBeUndefined()
    expect(consoleD1Binding("cloudflare", { connection: { url: "libsql://db.example.com" } })).toBeUndefined()
    expect(consoleD1Binding("vercel", { driver: "d1" })).toBeUndefined()
    expect(resolveConsoleJournal("file:journal.sqlite", "DB", true)).toEqual({ databaseUrl: "file:journal.sqlite" })
    expect(resolveConsoleJournal(undefined, "DB", true)).toEqual({ d1Binding: "DB" })
    expect(resolveConsoleJournal(undefined, "DB", false)).toBeUndefined()
  })
})
