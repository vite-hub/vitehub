import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { scheduleLeaseStoreFromDatabase } from "../src/runtime/process.ts"
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

async function generatedPlugin(plugins: unknown[]): Promise<string> {
  const root = await projectRoot()
  const plugin = hubSchedule({ projectRoot: root, providerOutput: false, runtime: { driver: "process", leaseTtlMs: 30_000, prefix: "app:schedule" } })
  await (plugin.config as (config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<unknown>)(
    { plugins, root },
    { command: "build", mode: "production" },
  )
  return await readFile(join(root, ".vitehub", "nitro", "schedule", "plugin.ts"), "utf8")
}

describe("Process Runtime leases in the generated Nitro plugin", () => {
  it("claims occurrences in the Default Database when the app has the Database plugin", async () => {
    const generated = await generatedPlugin([[{ name: "@vite-hub/database/vite" }]])

    expect(generated).toContain("import { databases } from \"@vite-hub/database/drizzle\"")
    expect(generated).toContain("const leases = scheduleLeaseStoreFromDatabase(databases.default.db)")
    expect(generated).toContain("...(leases ? { leases } : {}),")
    expect(generated).toContain("\"leaseTtlMs\": 30000")
    expect(generated).toMatch(/const processRuntimeOptions = \{[^}]*"prefix": "app:schedule"/s)
  })

  it("keeps leases in memory without the Database plugin", async () => {
    const generated = await generatedPlugin([])

    expect(generated).not.toContain("databases")
    expect(generated).not.toContain("leases")
  })

  it("warns in a build without a Database that each server runs every occurrence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const root = await projectRoot()

    await createScheduleNitroConfig({ command: "build", projectRoot: root, providerOutput: false, root, runtime: { driver: "process" } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("claims each Schedule occurrence in memory"))

    warn.mockClear()
    await createScheduleNitroConfig({ command: "build", leaseDatabaseImport: "vite-hub/database/drizzle", projectRoot: root, providerOutput: false, root, runtime: { driver: "process" } } as Parameters<typeof createScheduleNitroConfig>[0])
    await createScheduleNitroConfig({ command: "serve", projectRoot: root, providerOutput: false, root, runtime: { driver: "process" } })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("scheduleLeaseStoreFromDatabase", () => {
  it("runs the lease SQL through postgres.js with numbered parameters", async () => {
    const unsafe = vi.fn(async (sql: string) => sql.startsWith("insert") ? [{ expires_at: Date.now() + 1000, id: "" }] : [])
    const leases = scheduleLeaseStoreFromDatabase({ $client: { unsafe } })

    await leases?.acquire("schedule/srun_static_daily_2026-11-09T08:00:00.000Z", { ttl: 1 })

    expect(leases).toBeDefined()
    expect(unsafe).toHaveBeenCalledWith(expect.stringContaining("values ($1, $2, $3,"), expect.arrayContaining(["schedule/srun_static_daily_2026-11-09T08:00:00.000Z"]))
  })

  it("runs the lease SQL through libSQL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const execute = vi.fn(async () => ({ rows: [] }))
    const leases = scheduleLeaseStoreFromDatabase({ $client: { execute, protocol: "ws" } })
    expect(warn).not.toHaveBeenCalled()

    await leases?.get("schedule/srun_static_daily_2026-11-09T08:00:00.000Z")

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ args: ["schedule/srun_static_daily_2026-11-09T08:00:00.000Z"] }))
  })

  it("warns that a local libSQL file is safe for one process only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(scheduleLeaseStoreFromDatabase({ $client: { execute: vi.fn(), protocol: "file" } })).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("local libSQL file"))
  })

  it("returns undefined for a Database without a postgres.js or libSQL client", () => {
    const missing = new Proxy({}, {
      get() {
        throw new Error("Database is disabled.")
      },
    })

    expect(scheduleLeaseStoreFromDatabase({ $client: { prepare() {} } })).toBeUndefined()
    expect(scheduleLeaseStoreFromDatabase(missing)).toBeUndefined()
  })
})
