import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { writeHostedDatabaseRuntimeModules } from "../src/internal/vite-build.ts"
import { createAgentDatabase, createDatabaseBindingLookup, pingDatabaseEntries } from "../src/runtime/agent.ts"
import { createUseDatabase } from "../src/runtime/use-database.ts"

afterEach(() => vi.restoreAllMocks())

describe("pingDatabaseEntries()", () => {
  it("runs SELECT 1 on SQLite and Postgres Databases and logs the ones that fail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const run = vi.fn(async () => ({}))
    const execute = vi.fn(async () => [])
    const failure = new Error("connect ECONNREFUSED postgres://user:secret@db:5432/app")

    const result = await pingDatabaseEntries({
      default: { db: { all: vi.fn(), run } },
      analytics: { db: { execute } },
      archive: { db: { execute: vi.fn(async () => { throw failure }) } },
    }, ["default", "analytics", "archive"])

    expect(result).toEqual({ default: true, analytics: true, archive: false })
    expect(run).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith("[vitehub] Database \"archive\" did not answer SELECT 1.", failure)
  })
})

it("pings only the configured Databases of a hosted runtime module", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-db-ping-"))
  try {
    await mkdir(join(root, "server/databases"), { recursive: true })
    await writeFile(join(root, "server/databases/analytics.ts"), "export default defineDatabase({ name: \"analytics\", schema: {} })\n")
    const output = join(root, ".vitehub/database")
    await writeHostedDatabaseRuntimeModules(output, resolveDBViteConfig(undefined, root)!)
    const code = await readFile(join(output, "vercel-runtime.mjs"), "utf8")
    const evaluable = code.replace(/^(?:import .+|export .+ from .+)$/gm, "").replace(/^export /gm, "") + "\nreturn { pingDatabases }"
    const run = vi.fn(async () => ({}))
    const runtime = new Function("definition_0", "schema_0", "relations_0", "createHostedDrizzleDb", "createAgentDatabase", "createDatabaseBindingLookup", "defaultDatabaseNotConfiguredError", "pingDatabaseEntries", "resolveRuntimeCloudflareConfig", "createUseDatabase", evaluable)(
      { drizzle: {}, schema: {} },
      {},
      {},
      () => ({ all: vi.fn(), run }),
      createAgentDatabase,
      createDatabaseBindingLookup,
      () => new Error("missing"),
      pingDatabaseEntries,
      (value: unknown) => value,
      createUseDatabase,
    ) as { pingDatabases: () => Promise<Record<string, boolean>> }

    expect(await runtime.pingDatabases()).toEqual({ analytics: true })
    expect(run).toHaveBeenCalledOnce()
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
