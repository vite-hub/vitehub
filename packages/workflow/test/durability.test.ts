import { describe, expect, it } from "vitest"

import { workflowDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

const env = (name: string) => ({ kind: "env-variable" as const, source: { kind: "env" as const, name } })
const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }

describe("workflowDurability", () => {
  it("reports the inline runner of the default provider on Node as process state", () => {
    expect(workflowDurability({ provider: "vercel" }, context())).toMatchObject([{ primitive: "workflow", store: "inline", scope: "process" }])
  })

  it("follows the OpenWorkflow storage order at boot", () => {
    expect(workflowDurability({ provider: "openworkflow" }, context())).toMatchObject([{ store: "openworkflow-sqlite", scope: "host" }])
    expect(workflowDurability({ provider: "openworkflow" }, context({ DATABASE_URL: "postgres://db/app" }))).toMatchObject([{ store: "openworkflow-postgres", scope: "shared" }])
    expect(workflowDurability({ provider: "openworkflow" }, context({ OPENWORKFLOW_POSTGRES_URL: "postgres://db/runs" }))).toMatchObject([{ scope: "shared", reason: expect.stringContaining("OPENWORKFLOW_POSTGRES_URL") }])
    expect(workflowDurability({ provider: "openworkflow" }, context({ DATABASE_URL: "postgres://db/app", OPENWORKFLOW_SQLITE_PATH: "runs.db" }))).toMatchObject([{ store: "openworkflow-sqlite", scope: "host", reason: "Runs in the SQLite file runs.db on this host." }])
    expect(workflowDurability({ postgresUrl: env("RUNS_URL"), provider: "openworkflow" }, context({ OPENWORKFLOW_SQLITE_PATH: "runs.db", RUNS_URL: "postgres://db/runs" }))).toMatchObject([{ scope: "shared" }])
    expect(workflowDurability({ provider: "openworkflow", sqlitePath: "data/runs.db" }, context({ DATABASE_URL: "postgres://db/app" }))).toMatchObject([{ scope: "host" }])
  })

  it("uses the Postgres Default Database instead of DATABASE_URL when the build says so", () => {
    expect(workflowDurability({ defaultDatabase: true, provider: "openworkflow" }, context({}, [postgres]))).toMatchObject([{ scope: "shared", reason: expect.stringContaining("Default Database") }])
    expect(workflowDurability({ defaultDatabase: true, provider: "openworkflow" }, context({ DATABASE_URL: "postgres://db/app" }))).toMatchObject([{ store: "openworkflow-sqlite", scope: "host" }])
  })
})
