import { describe, expect, it } from "vitest"

import { agentInvocationsDurability, agentStateDurability } from "../src/durability.ts"

import type { Durability, DurabilityContext } from "@vite-hub/runtime/durability"

function context(env: Record<string, string | undefined> = {}, reports: readonly Durability[] = []): DurabilityContext {
  return { env, find: (primitive, name = "default") => reports.find(report => report.primitive === primitive && (report.name ?? "default") === name) }
}

describe("agentStateDurability", () => {
  it("classifies the state store, with VITEHUB_AGENT_STATE_URL first", () => {
    expect(agentStateDurability({ provider: "cloudflare" }, context())).toMatchObject([{ scope: "shared" }])
    expect(agentStateDurability({ provider: "memory" }, context())).toMatchObject([{ scope: "process" }])
    expect(agentStateDurability({ provider: "libsql", url: "file:.vitehub/data/agent-state.sqlite" }, context())).toMatchObject([{ store: "sqlite", scope: "host" }])
    expect(agentStateDurability({ provider: "libsql", url: "remote" }, context())).toMatchObject([{ store: "libsql", scope: "shared" }])
    expect(agentStateDurability({ provider: "libsql", url: "file:state.db" }, context({ VITEHUB_AGENT_STATE_URL: "libsql://state.turso.io" }))).toMatchObject([{ scope: "shared" }])
    expect(agentStateDurability({ provider: "libsql" }, context())).toMatchObject([{ scope: "process", fix: expect.stringContaining("VITEHUB_AGENT_STATE_URL") }])
  })
})

describe("agentInvocationsDurability", () => {
  it("reports the default journal file, moved by its env var at boot", () => {
    expect(agentInvocationsDurability({ store: "file" }, context())).toMatchObject([{ store: "sqlite", scope: "host", reason: expect.stringContaining(".vitehub/data/agent-invocations.sqlite") }])
    expect(agentInvocationsDurability({ store: "file" }, context({ VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: "libsql://journal.turso.io" }))).toMatchObject([{ scope: "shared" }])
    expect(agentInvocationsDurability({ store: "file", url: "remote" }, context())).toMatchObject([{ scope: "shared" }])
  })

  it("follows the Database of the database store", () => {
    const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
    expect(agentInvocationsDurability({ store: "database" }, context({}, [postgres]))).toMatchObject([{ store: "database (postgres)", scope: "shared" }])
    expect(agentInvocationsDurability({ store: "memory" }, context())).toMatchObject([{ scope: "process" }])
    expect(agentInvocationsDurability({ store: "d1" }, context())).toMatchObject([{ scope: "shared" }])
  })
})
