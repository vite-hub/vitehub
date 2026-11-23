import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { collectDurability } from "@vite-hub/runtime/durability"
import { describe, expect, it } from "vitest"

import { agentChatStreamsDurability, agentInvocationsDurability, agentProcessHostDurability, agentRecoveryDurability, agentStateDurability } from "../src/durability.ts"
import { resolveDefaultAgentInvocationsLocation } from "../src/invocations/default-core.ts"

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

  it("reports the file that the journal opens next to a file Agent State", async () => {
    const stateUrl = "file:.vitehub/agent-state.db"
    const cases: { env: Record<string, string>, file: string }[] = [
      { env: {}, file: ".vitehub/agent-invocations.sqlite" },
      { env: { VITEHUB_AGENT_STATE_URL: "file:///srv/data/state.db" }, file: "/srv/data/agent-invocations.sqlite" },
      { env: { VITEHUB_AGENT_STATE_URL: "libsql://state.turso.io" }, file: ".vitehub/data/agent-invocations.sqlite" },
    ]
    for (const { env, file } of cases) {
      const [report] = agentInvocationsDurability({ store: "file", stateUrl }, context(env))
      const opened = await resolveDefaultAgentInvocationsLocation({ env, projectRoot: process.cwd(), stateUrl })
      expect(report).toMatchObject({ store: "sqlite", scope: "host", reason: `The SQLite file ${file} on this host.` })
      expect(fileURLToPath(opened.url)).toBe(resolve(process.cwd(), file))
    }
    expect(agentInvocationsDurability({ store: "file", stateUrl: "file::memory:" }, context())).toMatchObject([{ reason: expect.stringContaining(".vitehub/data/agent-invocations.sqlite") }])
    expect(agentInvocationsDurability({ store: "file", stateUrl }, context({ VITEHUB_AGENT_INVOCATIONS_DATABASE_URL: "file:/var/journal.sqlite" }))).toMatchObject([{ reason: "The SQLite file /var/journal.sqlite on this host." }])
  })

  it("follows the Database of the database store", () => {
    const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
    expect(agentInvocationsDurability({ store: "database" }, context({}, [postgres]))).toMatchObject([{ store: "database (postgres)", scope: "shared" }])
    expect(agentInvocationsDurability({ store: "memory" }, context())).toMatchObject([{ scope: "process" }])
    expect(agentInvocationsDurability({ store: "d1" }, context())).toMatchObject([{ scope: "shared" }])
  })
})

describe("agentRecoveryDurability", () => {
  it("reports the sweep under a Lease in the default Database, else recovery at startup", () => {
    const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
    expect(agentRecoveryDurability({ sweep: true }, context({}, [postgres]))).toMatchObject([{ primitive: "agent-recovery", store: "lease (postgres)", scope: "shared" }])
    expect(agentRecoveryDurability({ sweep: true }, context())).toMatchObject([{ store: "startup", scope: "process", fix: expect.stringContaining("agent-recovery:<agent>") }])
    expect(agentRecoveryDurability({ sweep: false }, context({}, [postgres]))).toMatchObject([{ store: "startup", scope: "process" }])
  })

  it("uses the default or sole Lease Database, but not an ambiguous name", () => {
    const jobs: Durability = { primitive: "database", name: "jobs", store: "postgres", scope: "shared", reason: "Postgres." }
    const local: Durability = { primitive: "database", name: "default", store: "sqlite", scope: "host", reason: "Local SQLite." }
    function report(databases: Durability[]) {
      return collectDurability([
        { primitive: "database", report: () => databases },
        { primitive: "agent-recovery", report: context => agentRecoveryDurability({ sweep: true }, context) },
      ], {}).at(-1)
    }
    expect(report([jobs])).toMatchObject({ store: "lease (postgres)", scope: "shared", reason: expect.stringContaining("jobs Database") })
    expect(report([jobs, local])).toMatchObject({ store: "lease (sqlite)", scope: "host" })
    expect(report([jobs, { ...local, name: "other" }])).toMatchObject({ store: "startup", scope: "process" })
  })
})

describe("agentProcessHostDurability", () => {
  it("is shared only when a Lease in a shared Database runs the host", () => {
    const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
    const file: Durability = { primitive: "database", store: "sqlite", scope: "process", reason: "A local file.", fix: "Use a remote Database." }
    expect(agentProcessHostDurability({ lease: true }, context({}, [postgres]))).toMatchObject([{ primitive: "agent-process-host", store: "lease (postgres)", scope: "shared" }])
    expect(agentProcessHostDurability({ lease: true }, context({}, [file]))).toMatchObject([{ store: "lease (sqlite)", scope: "process", fix: "Use a remote Database." }])
    expect(agentProcessHostDurability({ lease: true }, context())).toMatchObject([{ store: "process", scope: "process", fix: expect.stringContaining("agent-process-host:<agent>") }])
    expect(agentProcessHostDurability({ lease: false }, context({}, [postgres]))).toMatchObject([{ store: "process", scope: "process" }])
  })
})

describe("agentChatStreamsDurability", () => {
  it("says shared only when the journal database is shared", () => {
    const postgres: Durability = { primitive: "database", store: "postgres", scope: "shared", reason: "Postgres." }
    expect(agentChatStreamsDurability({ store: "database" }, context({}, [postgres]))).toMatchObject([{ primitive: "agent-chat-streams", store: "database (postgres)", scope: "shared" }])
    expect(agentChatStreamsDurability({ store: "d1" }, context())).toMatchObject([{ primitive: "agent-chat-streams", scope: "shared" }])
    expect(agentChatStreamsDurability({ store: "file", url: "remote" }, context())).toMatchObject([{ scope: "shared" }])
    expect(agentChatStreamsDurability({ store: "file" }, context())).toMatchObject([{ primitive: "agent-chat-streams", store: "sqlite", scope: "host", fix: expect.any(String) }])
    expect(agentChatStreamsDurability({ store: "memory" }, context())).toMatchObject([{ scope: "process", reason: expect.stringContaining("only `resumable.scope: \"process\"` works") }])
  })
})
