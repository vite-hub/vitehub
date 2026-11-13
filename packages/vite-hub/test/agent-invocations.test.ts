import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ownModule } from "@vite-hub/internal/build/paths"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAgent as defineUpstreamAgent } from "@vite-hub/agent"
import { runAgentWithContext } from "@vite-hub/agent/server/internal"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import { defineAgent } from "../src/agent.ts"
import { agentInvocationsDisabledKey, installAgentInvocations, resolveDefaultAgentInvocations } from "@vite-hub/agent/invocations/app"
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

// The libSQL driver that the generated plugin passes outside a Cloudflare production build.
const libsqlModule = ownModule(import.meta.url, "internal/agent-invocations-libsql")
const libsql = async () => await import("../src/internal/agent-invocations-libsql.ts")

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
    await runAgentWithContext(agent, context(), { prompt: "Hello" })
    await expect(recordedAgents(agent)).resolves.toEqual(["completed"])
  })

  it("accepts the long form with journal options", async () => {
    const agent = defineAgent({ driver, invocations: { content: "content", store: "memory" }, name: "long" })
    await runAgentWithContext(agent, context(), { prompt: "Keep this prompt" })
    const { invocations: [summary] } = await agent.invocations!.list({ limit: 1 })
    const record = await agent.invocations!.get(summary!.id)
    expect(JSON.stringify(record?.observations)).toContain("Keep this prompt")
  })

  it("loads the Database store on first use with the selected Database name", async () => {
    const agent = defineAgent({ driver, invocations: { database: "journal", store: "database" }, name: "database" })
    await expect(agent.invocations!.list()).rejects.toThrow("requires ViteHub Database")

    const database = databaseModule()
    installAgentInvocations({ database: database.load })
    await runAgentWithContext(agent, context(), { prompt: "Hello" })
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
    await runAgentWithContext(agent, context(), { prompt: "Hello" })
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

  it("records no journal outside the ViteHub server, which installs the default journal", () => {
    expect(defineAgent({ driver, name: "plain" }).invocations).toBeUndefined()
  })

  it("is the same function in vite-hub/agent and @vite-hub/agent", async () => {
    expect(defineAgent).toBe(defineUpstreamAgent)
    const agent = defineUpstreamAgent({ driver, invocations: "memory", name: "owner" })
    await runAgentWithContext(agent, context(), { prompt: "Hello" })
    await expect(recordedAgents(agent)).resolves.toEqual(["completed"])
  })
})

describe("Default Agent journal", () => {
  it("records with the Console off, and the Console reads the same records when it is on", { timeout: 30_000 }, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-default-journal-"))
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "")
    try {
      // The generated server installs the same journal with the Console on or off. Here the Console is off.
      installAgentInvocations({ journal: { libsql, projectRoot } })
      const agent = defineAgent({ driver: { run: () => "recorded" }, name: "support" })
      await runAgentWithContext(agent, { ...context(), run: { runId: "console-off" } }, { prompt: "Record me" })
      await vi.waitFor(async () => {
        await expect(agent.invocations!.getByRunId("console-off", "support")).resolves.toMatchObject({ status: "completed" })
      })
      expect(resolveConsoleInvocations()).toBeUndefined()
      await expect(readFile(join(projectRoot, ".vitehub/data/agent-invocations.sqlite"))).resolves.toBeInstanceOf(Buffer)

      // A new server process with the Console on: it installs the same default journal and the Console reads it.
      Reflect.deleteProperty(globalThis, Symbol.for("vitehub.agent.invocations.default"))
      installAgentInvocations({ journal: { libsql, projectRoot } })
      const restarted = defineAgent({ driver: { run: () => "recorded" }, name: "support" })
      installConsoleAgentDefinitions([{ definition: { default: restarted }, fallbackName: "support" }], { projectRoot })
      const consoleJournal = resolveConsoleInvocations()
      expect(consoleJournal).toBe(resolveDefaultAgentInvocations())
      expect(restarted.invocations).toBe(consoleJournal)
      const record = await consoleJournal!.getByRunId("console-off", "support")
      expect(record).toMatchObject({ agentName: "support", status: "completed" })
      expect(JSON.stringify(record?.observations)).toContain("Record me")
    }
    finally {
      vi.unstubAllEnvs()
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("records a run of an Agent from @vite-hub/agent in the Console journal", { timeout: 30_000 }, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-owner-journal-"))
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "")
    try {
      installAgentInvocations({ journal: { libsql, projectRoot } })
      const agent = defineUpstreamAgent({ driver: { run: () => "recorded" }, name: "owner" })
      installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "owner" }], { projectRoot })
      const consoleJournal = resolveConsoleInvocations()
      expect(consoleJournal).toBe(resolveDefaultAgentInvocations())
      await runAgentWithContext(agent, { ...context(), run: { runId: "owner-run" } }, { prompt: "Record the owner Agent" })
      await vi.waitFor(async () => {
        await expect(consoleJournal!.getByRunId("owner-run", "owner")).resolves.toMatchObject({ agentName: "owner", status: "completed" })
      })
    }
    finally {
      vi.unstubAllEnvs()
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("rejects the old Console journal URL variable", () => {
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:/var/lib/app/console.sqlite")
    try {
      expect(() => installAgentInvocations({ journal: { libsql, projectRoot: process.cwd() } })).toThrow(expect.objectContaining({ code: "AGENT_R1032", message: expect.stringContaining("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL") }))
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("reads an empty journal in the Console when the app turns journals off", async () => {
    installAgentInvocations({ default: false, journal: { projectRoot: process.cwd() } })
    const agent = defineAgent({ driver, name: "support" })
    installConsoleAgentDefinitions([{ definition: { default: agent }, fallbackName: "support" }], { projectRoot: process.cwd() })
    expect(agent.invocations).toBeUndefined()
    await expect(resolveConsoleInvocations()!.list()).resolves.toMatchObject({ invocations: [] })
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

/** The Agent Invocations plugin that Vite keeps for an app without the Content `cms` preset. */
function agentInvocationsPlugin(options: Parameters<typeof vitehub>[0]): Plugin | undefined {
  // vitehub() also lists the plugins of the cms preset case, whose `apply` drops them in other apps.
  return vitehub(options)
    .filter((candidate): candidate is Plugin => !!candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/agent-invocations")
    .find(plugin => !(plugin.apply instanceof Function) || plugin.apply({ root: "/vitehub-test-app-without-content" }, { command: "build", mode: "production" }))
}

describe("vitehub({ agent: { invocations } })", () => {
  it("generates a Nitro plugin that loads before the Console plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-"))
    try {
      const plugin = agentInvocationsPlugin({ agent: { invocations: { database: "journal", store: "database" } }, database: true, host: "node" })
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

  it("renders the default journal for an app that sets no journal", () => {
    expect(renderAgentInvocationsNitroPlugin({ database: false, projectRoot: "/app" })).toContain(`installAgentInvocations({ journal: { projectRoot: "/app", libsql: () => import(${JSON.stringify(libsqlModule)}) } })`)
    expect(renderAgentInvocationsNitroPlugin({ database: false, d1Binding: "DB", default: { retention: { maxAge: "14d" } }, projectRoot: "/app" }))
      .toContain(`installAgentInvocations({ default: {"retention":{"maxAge":"14d"}}, journal: { projectRoot: "/app", d1: { binding: "DB", env: async () => (await import("cloudflare:workers")).env }, libsql: () => import(${JSON.stringify(libsqlModule)}) } })`)
    // A store setting needs no default journal location.
    expect(renderAgentInvocationsNitroPlugin({ database: false, default: "memory", projectRoot: "/app" })).toContain(`installAgentInvocations({ default: "memory" })`)
  })

  it.each([false, true])("generates the same journal plugin with the Console on: %s", async (consoleOn) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-console-"))
    try {
      // `comments: false` keeps the Database off, so the Console adds nothing else to the generated plugin.
      const plugin = agentInvocationsPlugin({ agent: true, host: "node", ...(consoleOn ? { comments: false, console: { auth: false } } : {}) })
      if (!plugin) throw new Error("Missing Agent Invocations plugin.")
      // SAFETY: The plugin reads only the root and the Nitro config, which this fixture supplies.
      const hook = plugin.config as (config: object, environment: object) => Promise<void>
      await hook({ root }, { command: "build", mode: "production" })
      await expect(readFile(join(root, ".vitehub/nitro/agent/invocations.mjs"), "utf8")).resolves.toBe(renderAgentInvocationsNitroPlugin({ database: false, projectRoot: root }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("renders only the configured parts", () => {
    expect(renderAgentInvocationsNitroPlugin({ database: true })).toContain(`installAgentInvocations({ database: () => import("vite-hub/agent/invocations/database") })`)
    expect(renderAgentInvocationsNitroPlugin({ database: false, default: "memory" })).toContain(`installAgentInvocations({ default: "memory" })`)
    expect(renderAgentInvocationsNitroPlugin({ database: false, default: "memory" })).toContain(`import { installAgentInvocations } from "@vite-hub/agent/invocations/app"`)
  })

  it("adds the plugin for every app with Agents, unless the app turns journals off", () => {
    expect(agentInvocationsPlugin({ agent: true, host: "node" })).toBeDefined()
    expect(agentInvocationsPlugin({ agent: { invocations: { retention: { maxAge: "14d" } } }, host: "node" })).toBeDefined()
    expect(agentInvocationsPlugin({ agent: { invocations: false }, host: "node" })).toBeUndefined()
    expect(agentInvocationsPlugin({ agent: true, database: true, host: "node" })).toBeDefined()
    expect(agentInvocationsPlugin({ agent: { invocations: "memory" }, host: "node" })).toBeDefined()
    expect(agentInvocationsPlugin({ database: true, host: "node" })).toBeUndefined()
  })

  it("requires Database for the Database journal and a Nitro Agent host", () => {
    expect(() => vitehub({ agent: { invocations: "database" }, host: "node" })).toThrow("requires database")
    expect(() => vitehub({ agent: { invocations: "memory" }, host: "netlify" })).toThrow("requires Nitro-hosted Agents")
    expect(() => vitehub({ agent: { invocations: "memory", runtime: "deno" }, host: "node" })).toThrow("requires Nitro-hosted Agents")
  })

  it.each([
    undefined,
    {},
    { retention: { maxAge: "14d" } },
    { databaseUrl: "libsql://journal.example.com" },
  ] as const)("rejects the default journal %j on standalone Agent outputs", (invocations) => {
    const error = expect.objectContaining({ code: "VITE_HUB_R0132" })
    expect(() => vitehub({ agent: { invocations }, host: "netlify" })).toThrow(error)
    expect(() => vitehub({ agent: { invocations, runtime: "deno" }, host: "node" })).toThrow(error)
    expect(() => vitehub({ agent: { invocations }, host: "deno" })).not.toThrow()
  })

  it("requires an explicit journal opt-out on standalone Agent outputs", () => {
    expect(() => vitehub({ agent: true, host: "netlify" })).toThrow(expect.objectContaining({ code: "VITE_HUB_R0132" }))
    expect(() => vitehub({ agent: { invocations: false }, host: "netlify" })).not.toThrow()
    expect(() => vitehub({ agent: { invocations: false, runtime: "deno" }, host: "node" })).not.toThrow()
    expect(() => vitehub({ host: "netlify" })).not.toThrow()
  })
})
