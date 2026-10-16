import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAgent as defineUpstreamAgent, runAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { defineAgent } from "../src/agent.ts"
import { agentInvocationsDisabledKey, installAgentInvocations, resolveDefaultAgentInvocations } from "../src/_internal/agent/invocations.ts"
import { renderAgentInvocationsNitroPlugin } from "../src/agent-invocations-vite.ts"
import {
  consoleInvocationsIdentityKey,
  consoleInvocationsIdentityRootKey,
  consoleInvocationsKey,
  consoleInvocationsRegistryKey,
  consoleInvocationsRootIdentityRegistryKey,
  consoleInvocationsRootKey,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  type ConsoleInvocationScope,
} from "../src/console/internal.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { vitehub } from "../src/index.ts"

import type { AgentInvocationStore } from "@vite-hub/agent/server"
import type { Plugin } from "vite"

const driver = { run: () => "done" }
const context = () => ({ memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() })
// SAFETY: ConsoleInvocationScope adds only optional symbol-keyed state to the global object.
const scope = globalThis as ConsoleInvocationScope

afterEach(() => {
  installAgentInvocations({})
  for (const target of [scope, process]) {
    for (const key of [consoleInvocationsKey, consoleInvocationsIdentityKey, consoleInvocationsIdentityRootKey, consoleInvocationsRootKey, consoleInvocationsRegistryKey, consoleInvocationsRootIdentityRegistryKey]) {
      Reflect.deleteProperty(target, key)
    }
  }
})

async function recordedAgents(agent: { invocations?: unknown }): Promise<string[]> {
  const invocations = agent.invocations
  if (!invocations || !("list" in Object(invocations))) throw new TypeError("Expected an Agent journal.")
  // SAFETY: The check above confirms the journal list method used by this assertion.
  const { invocations: records } = await (invocations as ReturnType<typeof defineAgentInvocations>).list({ limit: 10 })
  return records.map(record => record.status)
}

function databaseModule() {
  const store = createMemoryAgentInvocationStore()
  const createDatabaseAgentInvocationStore = vi.fn((_options?: { database?: string }): AgentInvocationStore => store)
  return { createDatabaseAgentInvocationStore, load: vi.fn(async () => ({ createDatabaseAgentInvocationStore })) }
}

describe("defineAgent({ invocations })", () => {
  it("records runs in a memory journal and keeps one journal per Agent", async () => {
    const agent = defineAgent({ driver, invocations: "memory", name: "memory" })
    expect(agent.invocations).toBe(agent.invocations)
    await runAgent(agent, context(), { prompt: "Hello" })
    await expect(recordedAgents(agent)).resolves.toEqual(["completed"])
  })

  it("accepts the long form with journal options", async () => {
    const agent = defineAgent({ driver, invocations: { content: "content", store: "memory" }, name: "long" })
    await runAgent(agent, context(), { prompt: "Keep this prompt" })
    const { invocations: [summary] } = await agent.invocations!.list({ limit: 1 })
    const record = await agent.invocations!.get(summary!.id)
    expect(JSON.stringify(record?.observations)).toContain("Keep this prompt")
  })

  it("loads the Database store on first use with the selected Database name", async () => {
    const agent = defineAgent({ driver, invocations: { database: "journal", store: "database" }, name: "database" })
    await expect(agent.invocations!.list()).rejects.toThrow("requires ViteHub Database")

    const database = databaseModule()
    installAgentInvocations({ database: database.load })
    await runAgent(agent, context(), { prompt: "Hello" })
    await expect(recordedAgents(agent)).resolves.toEqual(["completed"])
    expect(database.createDatabaseAgentInvocationStore).toHaveBeenCalledExactlyOnceWith({ database: "journal" })
    expect(database.load).toHaveBeenCalledOnce()
  })

  it("uses the default Database name for the short form", async () => {
    const database = databaseModule()
    installAgentInvocations({ database: database.load })
    const agent = defineAgent({ driver, invocations: "database", name: "database" })
    await agent.invocations!.list()
    expect(database.createDatabaseAgentInvocationStore).toHaveBeenCalledExactlyOnceWith({})
  })

  it("keeps a journal object and wraps a custom store", async () => {
    const journal = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    expect(defineAgent({ driver, invocations: journal }).invocations).toBe(journal)

    const store = createMemoryAgentInvocationStore()
    const create = vi.spyOn(store, "create")
    const agent = defineAgent({ driver, invocations: { store }, name: "custom" })
    await runAgent(agent, context(), { prompt: "Hello" })
    expect(create).toHaveBeenCalledOnce()
  })

  it("rejects a Database name for another store", () => {
    // @ts-expect-error `database` applies only to the Database store.
    expect(() => defineAgent({ driver, invocations: { database: "journal", store: "memory" } })).toThrow("only with `store: \"database\"`")
  })

  it("applies the app-wide journal, and an Agent setting overrides it", async () => {
    installAgentInvocations({ default: "memory" })
    const shared = resolveDefaultAgentInvocations()
    expect(shared).toBeDefined()

    const inherits = defineAgent({ driver, name: "inherits" })
    expect(inherits.invocations).toBe(shared)
    const overrides = defineAgent({ driver, invocations: "memory", name: "overrides" })
    expect(overrides.invocations).not.toBe(shared)

    // The same setting keeps the same journal when the generated plugin loads again.
    installAgentInvocations({ default: "memory" })
    expect(resolveDefaultAgentInvocations()).toBe(shared)
  })

  it("records no journal for false, also with an app-wide journal and a Console journal", async () => {
    installAgentInvocations({ default: "memory" })
    installConsoleInvocationFallback(defineAgentInvocations({ store: createMemoryAgentInvocationStore() }), process.cwd())
    const agent = defineAgent({ driver, invocations: false, name: "off" })
    expect(agent.invocations).toBeUndefined()
    expect(Reflect.get(agent, agentInvocationsDisabledKey)).toBe(true)
    expect(defineAgent({ extends: agent, name: "child" }).invocations).toBeUndefined()

    const parent = defineAgent({ driver, invocations: "memory", name: "parent" })
    expect(defineAgent({ extends: parent, invocations: false, name: "child" }).invocations).toBeUndefined()
  })

  it("keeps history opt-in", () => {
    expect(defineAgent({ driver, name: "plain" }).invocations).toBeUndefined()
  })

  it("rejects a journal name in the Agent package defineAgent()", () => {
    expect(() => defineUpstreamAgent({ driver, invocations: "memory" } as never)).toThrow("Import defineAgent from vite-hub/agent")
  })
})

describe("Console journal", () => {
  it("shows the app-wide journal", () => {
    installAgentInvocations({ default: "memory" })
    const shared = resolveDefaultAgentInvocations()
    const agent = defineAgent({ driver, name: "support" })
    const off = defineAgent({ driver, invocations: false, name: "off" })
    installConsoleAgentDefinitions([
      { definition: { default: agent }, fallbackName: "support" },
      { definition: { default: off }, fallbackName: "off" },
    ], { projectRoot: process.cwd() })
    expect(resolveConsoleInvocations()).toBe(shared)
    expect(agent.invocations).toBe(shared)
    expect(off.invocations).toBeUndefined()
  })

  it("rejects an Agent journal that differs from the app-wide journal", () => {
    installAgentInvocations({ default: "memory" })
    expect(() => installConsoleAgentDefinitions([
      { definition: { default: defineAgent({ driver, name: "support" }) }, fallbackName: "support" },
      { definition: { default: defineAgent({ driver, invocations: "memory", name: "other" }) }, fallbackName: "other" },
    ], { projectRoot: process.cwd() })).toThrow("multiple Agent invocation journals")
  })
})

function agentInvocationsPlugin(options: Parameters<typeof vitehub>[0]): Plugin | undefined {
  return vitehub(options)
    .find((candidate): candidate is Plugin => !!candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/agent-invocations")
}

describe("vitehub({ agent: { invocations } })", () => {
  it("generates a Nitro plugin that loads before the Console plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-"))
    try {
      const plugin = agentInvocationsPlugin({ agent: { invocations: { database: "journal", store: "database" } }, database: true, preset: "node" })
      if (!plugin) throw new Error("Missing Agent Invocations plugin.")
      const config = { nitro: { plugins: ["/app/.vitehub/nitro/console/plugin.mjs"] }, root }
      // SAFETY: The plugin reads only the root and the Nitro config, which this fixture supplies.
      const hook = plugin.config as (config: object) => Promise<void>
      await hook(config)
      await hook(config)
      const generated = join(root, ".vitehub/nitro/agent/invocations.mjs")
      expect(config.nitro.plugins).toEqual([generated, "/app/.vitehub/nitro/console/plugin.mjs"])
      await expect(readFile(generated, "utf8")).resolves.toBe(renderAgentInvocationsNitroPlugin({ database: true, default: { database: "journal", store: "database" } }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("renders only the configured parts", () => {
    expect(renderAgentInvocationsNitroPlugin({ database: true })).toContain(`installAgentInvocations({ database: () => import("vite-hub/agent/invocations/database") })`)
    expect(renderAgentInvocationsNitroPlugin({ database: false, default: "memory" })).toContain(`installAgentInvocations({ default: "memory" })`)
    expect(renderAgentInvocationsNitroPlugin({ database: false, default: "memory" })).toContain(`import { installAgentInvocations } from "vite-hub/_internal/agent/invocations"`)
  })

  it("adds the plugin only for a Database or an app-wide journal", () => {
    expect(agentInvocationsPlugin({ agent: true, preset: "node" })).toBeUndefined()
    expect(agentInvocationsPlugin({ agent: { invocations: false }, preset: "node" })).toBeUndefined()
    expect(agentInvocationsPlugin({ agent: true, database: true, preset: "node" })).toBeDefined()
    expect(agentInvocationsPlugin({ agent: { invocations: "memory" }, preset: "node" })).toBeDefined()
    expect(agentInvocationsPlugin({ database: true, preset: "node" })).toBeUndefined()
  })

  it("requires Database for the Database journal and a Nitro Agent host", () => {
    expect(() => vitehub({ agent: { invocations: "database" }, preset: "node" })).toThrow("requires database")
    expect(() => vitehub({ agent: { invocations: "memory" }, preset: "netlify" })).toThrow("requires Nitro-hosted Agents")
    expect(() => vitehub({ agent: { invocations: "memory", runtime: "deno" }, preset: "node" })).toThrow("requires Nitro-hosted Agents")
  })
})
