import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { withDataDir } from "../src/storage-config.ts"
import { vitehub } from "../src/index.ts"

describe("Node storage defaults", () => {
  it("puts enabled local stores under the explicit directory", () => {
    const dataDir = "/var/lib/app data"
    expect(withDataDir({ preset: "node", dataDir, agent: true, console: true, kv: true, blob: true, workspace: true })).toMatchObject({
      agent: { providers: { state: { provider: "libsql", url: pathToFileURL(join(dataDir, "agent-state.sqlite")).href } } },
      console: { databaseUrl: pathToFileURL(join(dataDir, "console.sqlite")).href },
      kv: { driver: "fs-lite", base: join(dataDir, "kv") },
      blob: { driver: "fs", base: join(dataDir, "blob") },
      workspace: { root: join(dataDir, "workspaces") },
    })
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
