import { describe, expect, it } from "vitest"

import { workflowDurability } from "../src/durability.ts"

const env = (name: string) => ({ kind: "env-variable" as const, source: { kind: "env" as const, name } })

describe("workflowDurability", () => {
  it("reports the inline runner of the default provider on Node as process state", () => {
    expect(workflowDurability({ provider: "vercel" }, {})).toMatchObject([{ primitive: "workflow", store: "inline", scope: "process" }])
  })

  it("follows the OpenWorkflow storage order at boot", () => {
    expect(workflowDurability({ provider: "openworkflow" }, {})).toMatchObject([{ store: "openworkflow-sqlite", scope: "host" }])
    expect(workflowDurability({ provider: "openworkflow" }, { DATABASE_URL: "postgres://db/app" })).toMatchObject([{ store: "openworkflow-postgres", scope: "shared" }])
    expect(workflowDurability({ provider: "openworkflow" }, { DATABASE_URL: "postgres://db/app", OPENWORKFLOW_SQLITE_PATH: "runs.db" })).toMatchObject([{ store: "openworkflow-sqlite", scope: "host", reason: "Runs in the SQLite file runs.db on this host." }])
    expect(workflowDurability({ postgresUrl: env("RUNS_URL"), provider: "openworkflow" }, { OPENWORKFLOW_SQLITE_PATH: "runs.db", RUNS_URL: "postgres://db/runs" })).toMatchObject([{ scope: "shared" }])
    expect(workflowDurability({ provider: "openworkflow", sqlitePath: "data/runs.db" }, { DATABASE_URL: "postgres://db/app" })).toMatchObject([{ scope: "host" }])
  })
})
