import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createScheduleNitroConfig, hubSchedule } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-schedule-leases-"))
  roots.push(root)
  await mkdir(join(root, "server"), { recursive: true })
  return root
}

async function generatedPlugin(plugins: unknown[], internal: { requireKVPluginForProcessStores?: boolean } = {}): Promise<string> {
  const root = await projectRoot()
  // SAFETY: `requireKVPluginForProcessStores` is an internal option that vitehub() passes.
  const plugin = hubSchedule({ projectRoot: root, providerOutput: false, runtime: { driver: "process", leaseTtlMs: 30_000, prefix: "app:schedule" }, ...internal } as Parameters<typeof hubSchedule>[0])
  await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<unknown>)(
    { plugins, root },
    { command: "build", mode: "production" },
  )
  return await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
}

describe("Process Runtime leases in the generated Nitro plugin", () => {
  it("claims occurrences in the Default Database when the app has the Database plugin", async () => {
    const generated = await generatedPlugin([[{ name: "@vite-hub/database/vite" }]])

    expect(generated).toContain("import { useLeases } from \"@vite-hub/database\"")
    expect(generated).toContain("leases = useLeases()")
    expect(generated).toContain("...(leases ? { leases } : {}),")
    expect(generated).toContain("\"leaseTtlMs\": 30000")
    expect(generated).toMatch(/const processRuntimeOptions = \{[^}]*"prefix": "app:schedule"/s)
  })

  // vitehub() lists the Database and KV plugins of its `cms` variant with an `apply` that drops them when the app does
  // not use that variant. The `config` hook still sees them, and Vite can load the file this hook writes before
  // `configResolved` rewrites it.
  it("ignores Database and KV plugins that Vite does not apply", async () => {
    const generated = await generatedPlugin([[
      { name: "@vite-hub/database/vite", apply: () => false },
      { name: "@vite-hub/kv/vite", apply: "serve" },
    ]], { requireKVPluginForProcessStores: true })

    expect(generated).not.toContain("useLeases")
    expect(generated).toContain("createMemoryScheduleRunStore")
    expect(generated).not.toContain("scheduleKVStorage")
  })

  it("claims occurrences in the Default Database when the Database plugin applies to the command", async () => {
    const generated = await generatedPlugin([{ name: "@vite-hub/database/vite", apply: (_config: unknown, env: { command: string }) => env.command === "build" }])

    expect(generated).toContain("import { useLeases } from \"@vite-hub/database\"")
  })

  it("keeps leases in memory without the Database plugin", async () => {
    const generated = await generatedPlugin([])

    expect(generated).not.toContain("useLeases")
    expect(generated).not.toContain("{ leases }")
  })

  it("warns in a build without a Database that each server runs every occurrence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const root = await projectRoot()

    await createScheduleNitroConfig({ command: "build", projectRoot: root, providerOutput: false, root, runtime: { driver: "process" } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("claims each Schedule occurrence in memory"))

    warn.mockClear()
    await createScheduleNitroConfig({ command: "build", leaseDatabaseImport: "@vite-hub/database", projectRoot: root, providerOutput: false, root, runtime: { driver: "process" } } as Parameters<typeof createScheduleNitroConfig>[0])
    await createScheduleNitroConfig({ command: "serve", projectRoot: root, providerOutput: false, root, runtime: { driver: "process" } })
    expect(warn).not.toHaveBeenCalled()
  })
})
