import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "vite"
import { describe, expect, it } from "vitest"
import { withDataDir } from "../src/storage-config.ts"
import { vitehub } from "../src/index.ts"

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
