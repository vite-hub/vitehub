import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { defineAgent } from "../src/agent.ts"
import { vitehub } from "../src/index.ts"
import {
  consoleInvocationsBindingKey,
  consoleInvocationsBindingRegistryKey,
  consoleInvocationsBindingRootRegistryKey,
  consoleInvocationsIdentityKey,
  consoleInvocationsIdentityRootKey,
  consoleBlobKey,
  consoleBlobRegistryKey,
  consoleBlobRootKey,
  consoleInvocationsKey,
  consoleInvocationsRegistryKey,
  consoleInvocationsRevisionRegistryKey,
  consoleInvocationsRootIdentityRegistryKey,
  consoleInvocationsRootKey,
  consoleProjectRootKey,
  consoleProjectNameKey,
  consoleSectionsKey,
  consoleSectionsRootKey,
  consoleSectionsRegistryKey,
  createConsoleInvocationsIdentity,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleProjectName,
  resolveConsoleProjectRoot,
} from "../src/console/internal.ts"
import { serializeConsoleRefresh } from "../src/console/refresh.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureFallbackAgentName, consoleFixtureRevision, parseConsoleFixture } from "../src/console/fixture.ts"
import agentsHandler from "../src/console/runtime/server/agents.get.ts"
import { installConsoleAgentDefinitions, installConsoleAgents } from "../src/console/runtime/server/agents.ts"
import { createConsoleFixtureInvocations, createConsoleInvocations, installConsoleFixtureInvocations, installConsoleInvocations, resolveConsoleDatabaseOptions } from "../src/console/runtime/server/invocations.ts"
import invocationHandler from "../src/console/runtime/server/invocation.get.ts"
import invocationsHandler from "../src/console/runtime/server/invocations.get.ts"
import consolePageHandler from "../src/console/runtime/server/page.get.ts"
import { assertConsoleRequest } from "../src/console/runtime/server/request.ts"
import searchHandler from "../src/console/runtime/server/search.get.ts"
import { consoleSearch } from "../src/console/runtime/server/search.ts"
import sectionsHandler from "../src/console/runtime/server/sections.get.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleInvocationRootPlugin, consoleVitePlugin, updateConsoleInvocationRootState } from "../src/console/vite.ts"
import usageHandler from "../src/console/runtime/server/usage.get.ts"
import { createUsageSummary, invocationUsage } from "../src/console/runtime/server/usage.ts"

import { runAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { AgentInvocations, AgentRuntimeContext } from "@vite-hub/agent"
import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { Plugin } from "vite"
import type { ConsoleInvocationRootState } from "../src/console/vite.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"

const scope = globalThis as ConsoleInvocationScope
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- This test double only needs identity; no journal method is invoked through it.
const fakeInvocations = (name: string) => ({ name }) as unknown as AgentInvocations

function isPluginHookObject(value: unknown): value is { handler: unknown } {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite plugin hooks are functions or hook objects at this test boundary.
  return value !== null && typeof value === "object" && "handler" in value
}

function callPluginHook(hook: unknown, context: unknown, args: readonly unknown[] = []): unknown {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite plugin hooks are functions or hook objects at this test boundary.
  const candidate = typeof hook === "function"
    ? hook
    : isPluginHookObject(hook)
      ? hook.handler
      : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The structural Vite hook boundary is validated before invocation.
  if (typeof candidate !== "function") throw new TypeError("Expected a callable Vite plugin hook.")
  return Reflect.apply(candidate, context, args)
}

function fixtureDocument(id?: string) {
  return {
    invocations: id
      ? [{
          agentName: "support",
          createdAt: "2026-08-27T10:00:00.000Z",
          id,
          observations: [],
          status: "completed" as const,
          traceId: `${id}-trace`,
          updatedAt: "2026-08-27T10:00:00.000Z",
        }]
      : [],
    version: 1 as const,
  }
}

function event(address: string | undefined, method = "GET"): ConsoleRequestEvent {
  const headers = new Headers({ host: "localhost" })
  return {
    headers,
    method,
    node: { req: { method, socket: { remoteAddress: address }, url: "http://localhost/_vitehub" } },
    req: { method, url: "http://localhost/_vitehub" },
  }
}

function runtime(runId: string): AgentRuntimeContext {
  return {
    memo: vi.fn(),
    run: { runId },
    runtime: "unknown",
    waitUntil: vi.fn(),
  }
}

afterEach(() => {
  delete scope[consoleBlobKey]
  delete scope[consoleBlobRootKey]
  delete scope[consoleInvocationsKey]
  delete scope[consoleInvocationsIdentityKey]
  delete scope[consoleInvocationsIdentityRootKey]
  delete scope[consoleInvocationsBindingKey]
  delete scope[consoleInvocationsRootKey]
  Reflect.deleteProperty(process, consoleInvocationsKey)
  Reflect.deleteProperty(process, consoleInvocationsIdentityKey)
  Reflect.deleteProperty(process, consoleInvocationsIdentityRootKey)
  Reflect.deleteProperty(process, consoleInvocationsBindingKey)
  Reflect.deleteProperty(process, consoleInvocationsBindingRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsBindingRootRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRootKey)
  delete scope[consoleSectionsKey]
  delete scope[consoleProjectNameKey]
  delete scope[consoleSectionsRootKey]
  Reflect.deleteProperty(process, consoleBlobKey)
  Reflect.deleteProperty(process, consoleBlobRootKey)
  Reflect.deleteProperty(process, consoleBlobRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsKey)
  Reflect.deleteProperty(process, consoleProjectRootKey)
  Reflect.deleteProperty(process, consoleInvocationsRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRootIdentityRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRevisionRegistryKey)
  vi.unstubAllEnvs()
  Reflect.deleteProperty(process, consoleSectionsKey)
  Reflect.deleteProperty(process, consoleProjectNameKey)
  Reflect.deleteProperty(process, consoleSectionsRootKey)
  Reflect.deleteProperty(process, consoleSectionsRegistryKey)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Agent invocation console", () => {
  it("loads versioned invocation fixtures into an in-memory journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-"))
    try {
      const file = join(root, "console.fixture.json")
      await writeFile(file, JSON.stringify({
        invocations: [{
          agentName: "support",
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [{
            attributes: { "message.content": "Fixture reply", "message.role": "assistant" },
            name: "agent.message",
            sequence: 1,
            timestamp: "2026-08-27T10:00:01.000Z",
            type: "run",
          }],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:00:01.000Z",
        }],
        version: 1,
      }))

      const invocations = createConsoleFixtureInvocations(file)

      await expect(invocations.get("fixture-invocation")).resolves.toMatchObject({
        agentName: "support",
        observations: [expect.objectContaining({ name: "agent.message" })],
      })
      await expect(invocations.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "fixture-invocation" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("replaces an installed journal when the fixture identity changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-switch-"))
    const fixture = (id: string) => ({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id,
        observations: [],
        status: "completed",
        traceId: `${id}-trace`,
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })
    try {
      const firstFile = join(root, "first.json")
      const secondFile = join(root, "second.json")
      await writeFile(firstFile, JSON.stringify(fixture("first")))
      await writeFile(secondFile, JSON.stringify(fixture("second")))

      const first = installConsoleFixtureInvocations(root, firstFile)
      const second = installConsoleFixtureInvocations(root, secondFile)

      expect(second).not.toBe(first)
      await expect(second.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "second" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("replaces an installed journal when a fixture is rewritten in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-rewrite-"))
    const fixture = (id: string) => ({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id,
        observations: [],
        status: "completed",
        traceId: `${id}-trace`,
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })
    try {
      const file = join(root, "fixture.json")
      const firstFixture = parseConsoleFixture(fixture("first"))
      const firstRevision = consoleFixtureRevision(firstFixture)
      await writeFile(file, JSON.stringify(firstFixture))
      const first = installConsoleFixtureInvocations(root, file)
      const existingRealm = {
        process,
        [consoleInvocationsIdentityKey]: createConsoleInvocationsIdentity(root, file, firstRevision),
        [consoleInvocationsIdentityRootKey]: root,
        [consoleInvocationsRootKey]: root,
      }

      await writeFile(file, JSON.stringify(fixture("second")))
      const second = installConsoleFixtureInvocations(root, file)

      expect(second).not.toBe(first)
      expect(resolveConsoleInvocations(existingRealm)).toBe(first)
      expect(resolveConsoleInvocations()).toBe(second)
      expect(Reflect.get(process, consoleInvocationsRegistryKey).size).toBe(2)
      await expect(second.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "second" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("isolates same-revision fixture journals by runtime binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-runtime-"))
    try {
      const file = join(root, "fixture.json")
      const fixture = parseConsoleFixture(fixtureDocument("shared"))
      const revision = consoleFixtureRevision(fixture)
      await writeFile(file, JSON.stringify(fixture))

      const first = installConsoleFixtureInvocations(root, file, fixture, revision, "runtime-a")
      const second = installConsoleFixtureInvocations(root, file, fixture, revision, "runtime-b")
      const refreshedFirst = installConsoleFixtureInvocations(root, file, fixture, revision, "runtime-a")

      expect(second).not.toBe(first)
      expect(refreshedFirst).toBe(first)
      expect(createConsoleInvocationsIdentity(root, file, revision, "runtime-a"))
        .not.toBe(createConsoleInvocationsIdentity(root, file, revision, "runtime-b"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs reused fixture journals in the current runtime realm", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-realm-"))
    try {
      const file = join(root, "fixture.json")
      const fixture = parseConsoleFixture(fixtureDocument("shared"))
      const revision = consoleFixtureRevision(fixture)
      await writeFile(file, JSON.stringify(fixture))

      const first = installConsoleFixtureInvocations(root, file, fixture, revision, "runtime")
      delete scope[consoleInvocationsKey]
      delete scope[consoleInvocationsIdentityKey]
      delete scope[consoleInvocationsIdentityRootKey]
      delete scope[consoleInvocationsRootKey]

      const reused = installConsoleFixtureInvocations(root, file, fixture, revision, "runtime")

      expect(reused).toBe(first)
      expect(resolveConsoleInvocations()).toBe(first)
      expect(scope[consoleInvocationsIdentityKey]).toBe(createConsoleInvocationsIdentity(root, file, revision, "runtime"))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs a validated generated snapshot after the fixture changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-snapshot-"))
    try {
      const file = join(root, "fixture.json")
      const fixture = parseConsoleFixture(fixtureDocument("generated"))
      await writeFile(file, JSON.stringify(fixture))
      await writeFile(file, "not json")

      const invocations = installConsoleFixtureInvocations(root, file, fixture, consoleFixtureRevision(fixture))

      await expect(invocations.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "generated" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects malformed and duplicate fixture records", () => {
    expect(parseConsoleFixture({
      invocations: [{
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "anonymous",
        observations: [],
        status: "completed",
        traceId: "anonymous-trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    }).invocations[0]?.agentName).toBe(consoleFixtureFallbackAgentName)
    expect(() => parseConsoleFixture({ invocations: [], version: 2 })).toThrow("version must be 1")
    expect(() => parseConsoleFixture(fixtureDocument("a".repeat(513))))
      .toThrow("invocations[0].id must be at most 512 characters")
    expect(() => parseConsoleFixture({
      invocations: [0, 1].map(() => ({
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "duplicate",
        observations: [],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      })),
      version: 1,
    })).toThrow("duplicate invocation id")
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "missing-observation-fields",
        observations: [{ sequence: 0, type: "run" }],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })).toThrow("observations[0].name must be a non-empty string")
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "missing-observation-timestamp",
        observations: [{ name: "agent.message", sequence: 0, type: "run" }],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })).toThrow("observations[0].timestamp must be a non-empty string")
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00",
        id: "timezone-less-timestamp",
        observations: [],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })).toThrow("createdAt must be a valid timezone-qualified timestamp")
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "invalid-extension",
        metadata: { score: Number.POSITIVE_INFINITY },
        observations: [],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })).toThrow('invocations[0]["metadata"]["score"] must be a finite number')
    for (const observation of [
      { metadata: { score: Number.POSITIVE_INFINITY } },
      { trace: { id: "trace", metadata: { score: Number.POSITIVE_INFINITY } } },
    ]) {
      expect(() => parseConsoleFixture({
        invocations: [{
          agentName: "support",
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "invalid-observation-extension",
          observations: [{
            name: "agent.message",
            sequence: 0,
            timestamp: "2026-08-27T10:00:00.000Z",
            type: "run",
            ...observation,
          }],
          status: "completed",
          traceId: "trace",
          updatedAt: "2026-08-27T10:00:00.000Z",
        }],
        version: 1,
      })).toThrow("must be a finite number")
    }
  })

  it("serializes generated Agent registry refreshes", async () => {
    const releases: Array<() => void> = []
    const started: number[] = []
    const refresh = serializeConsoleRefresh(async () => {
      started.push(started.length)
      await new Promise<void>(resolve => releases.push(resolve))
    })

    const first = refresh()
    const second = refresh()
    await vi.waitFor(() => expect(started).toEqual([0]))
    releases.shift()?.()
    await vi.waitFor(() => expect(started).toEqual([0, 1]))
    releases.shift()?.()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it("registers the standalone console UI and invocation API with Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-host-"))
    try {
      await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "console-host" })}\n`)
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        blobStores: ["default", "archive"],
        console: { exposure: "host-managed" },
        kvStores: ["default", "cache"],
        preset: "node",
        sections: ["agents", "usage", "blob", "kv"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: {
          handlers: Array<{ handler: string, route: string }>
          plugins: string[]
          publicAssets: Array<{ baseURL: string, dir: string }>
        }
        root: string
      } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      if (!config.nitro) throw new TypeError("Expected the console Nitro configuration.")

      expect(config.nitro.handlers.map((handler) => handler.route)).toEqual([
        "/api/_vitehub/console/sections",
        "/api/_vitehub/console/agents",
        "/api/_vitehub/console/invocations",
        "/api/_vitehub/console/invocations/:id",
        "/api/_vitehub/console/search",
        "/api/_vitehub/console/usage",
        "/api/_vitehub/console/blob",
        "/_vitehub",
        "/_vitehub/**",
        "/api/_vitehub/console/kv",
      ])
      expect(config.nitro.publicAssets).toEqual([expect.objectContaining({ baseURL: "/_vitehub/assets" })])
      expect(config.nitro.plugins).toEqual([resolve(root, ".vitehub/nitro/console/plugin.mjs")])
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(`installConsoleSections(${JSON.stringify(root)}, ["agents","usage","blob","kv"])`)
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(`installConsoleProjectName(${JSON.stringify(root)}, "console-host")`)
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `installConsoleAgentDefinitions([`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `{ projectRoot: ${JSON.stringify(root)} }`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `fallbackName: "review"`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `installConsoleBlob(${JSON.stringify(root)}, vitehubConsoleBlob, ["default","archive"])`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `installConsoleKV(${JSON.stringify(root)}, vitehubConsoleKV, ["default","cache"])`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(`from "file://`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers Blob inspection without loading the Agent server graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-blob-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        blobStores: ["default", "archive"],
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["blob"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/api/_vitehub/console/sections",
        "/api/_vitehub/console/blob",
        "/_vitehub",
        "/_vitehub/**",
      ])
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).toContain(`from "vite-hub/console/blob"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(
        `installConsoleBlob(${JSON.stringify(root)}, vitehubConsoleBlob, ["default","archive"])`,
      )
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects a conflicting standalone Blob inspection handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-blob-conflict-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        blobStores: ["default"],
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["blob"],
      })
      const config = {
        nitro: {
          handlers: [{ handler: "~/server/api/blob.ts", route: "/api/_vitehub/console/blob" }],
        },
        root,
      }

      await expect(callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }]))
        .rejects.toThrow("Cannot install the Console Blob handler")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers only the section manifest and pages for a KV-only console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-kv-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "hidden.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        kvStores: ["default"],
        preset: "cloudflare",
        sections: ["kv"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map((handler) => handler.route)).toEqual(["/api/_vitehub/console/sections", "/_vitehub", "/_vitehub/**", "/api/_vitehub/console/kv"])
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
      expect(generated).not.toContain("installConsoleInvocations")
      expect(generated).toContain(`installConsoleKV(${JSON.stringify(root)}, vitehubConsoleKV, ["default"])`)
      expect(generated).not.toContain("hidden.agent")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("enables the KV section from resolved Vite configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-kv-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: kv => kv ? ["default", "cache"] : false,
      })
      const config: {
        kv?: unknown
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      config.kv = { stores: { default: {}, cache: {} } }
      await callPluginHook(plugin.configResolved, {}, [config])

      expect(config.nitro?.handlers.map(handler => handler.route)).toContain("/api/_vitehub/console/kv")
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
      expect(generated).toContain(`installConsoleKV(${JSON.stringify(root)}, vitehubConsoleKV, ["default","cache"])`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("disables Workflow inspection from resolved Vite configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-workflow-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        sections: ["workflows"],
      })
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
        workflow?: boolean
      } = { root, workflow: true }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers.map(handler => handler.route)).toContain("/api/_vitehub/console/definitions")
      config.workflow = false
      await callPluginHook(plugin.configResolved, {}, [config])

      expect(config.nitro?.handlers.map(handler => handler.route)).not.toContain("/api/_vitehub/console/definitions")
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
      expect(generated).not.toContain("installConsoleDefinitions")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("disables Queue inspection from resolved Vite configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-queue-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["queues"],
      })
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        queue?: boolean
        root: string
      } = { queue: true, root }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers.map(handler => handler.route)).toContain("/api/_vitehub/console/definitions")
      config.queue = false
      await callPluginHook(plugin.configResolved, {}, [config])

      expect(config.nitro?.handlers.map(handler => handler.route)).not.toContain("/api/_vitehub/console/definitions")
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).not.toContain("installConsoleDefinitions")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses configured server directories during resolved Workflow discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-workflow-server-dirs-"))
    try {
      const customServerDir = join(root, "backend")
      await writeFile(join(root, "package.json"), "{}\n")
      await mkdir(join(root, "server", "workflows", "welcome"), { recursive: true })
      await writeFile(join(root, "server", "workflows", "welcome.ts"), "export default null\n")
      await writeFile(join(root, "server", "workflows", "welcome", "01.step.ts"), "export default null\n")
      await mkdir(join(customServerDir, "workflows"), { recursive: true })
      await writeFile(join(customServerDir, "workflows", "custom.ts"), "export default null\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        sections: ["workflows"],
      })
      const config = {
        [VITEHUB_SERVER_DIRS]: [customServerDir],
        root,
        workflow: true,
      }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [config])

      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('"name":"custom"')
      expect(generated).not.toContain('"name":"welcome"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Workspace Definition metadata without initializing stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-workspace-host-"))
    try {
      await mkdir(join(root, "server/workspaces/docs/workspace"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/workspaces/docs/config.ts"),
        `export default defineWorkspace({ store: { provider: "memory" } })\nthrow new Error("The Console must not initialize Workspace Definitions during discovery.")\n`,
      )
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["workspaces"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }>; plugins: string[] }; root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [config])

      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).toContain(`from "vite-hub/console/definitions"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["workspaces"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"workspaces":[{"fields":[{"label":"Kind","value":"Workspace Definition"},{"label":"Source root","value":"server/workspaces/docs/workspace"}],"file":"server/workspaces/docs/config.ts","name":"docs","source":"server-workspaces-directory-config"}]})`)
      expect(generated).not.toContain("The Console must not initialize")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Database Definition metadata without loading schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-database-host-"))
    try {
      await mkdir(join(root, "server/databases"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/databases/config.ts"),
        `export default defineDatabase({ schema: { notes, users } })\nthrow new Error("The Console must not evaluate Database Definitions during discovery.")\n`,
      )
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["databases"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [config])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/api/_vitehub/console/sections",
        "/_vitehub",
        "/_vitehub/**",
        "/api/_vitehub/console/definitions",
      ])
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).toContain(`from "vite-hub/console/definitions"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["databases"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"databases":[{"fields":[{"label":"Mode","value":"Default"},{"label":"Tables","value":"notes, users"}],"file":"server/databases/config.ts","name":"default","source":"server-database-default"}]})`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Queue Definition metadata without loading handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-queue-host-"))
    try {
      await mkdir(join(root, "server/queues"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/queues/email.ts"),
        `throw new Error("The Console must not evaluate Queue Definitions during discovery.")\n`,
      )
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["queues"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/api/_vitehub/console/sections",
        "/_vitehub",
        "/_vitehub/**",
        "/api/_vitehub/console/definitions",
      ])
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["queues"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"queues":[{"fields":[],"file":"server/queues/email.ts","name":"email","source":"server-queues"}]})`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Rate Limit policies without loading application modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rate-limit-host-"))
    try {
      await mkdir(join(root, "server/api"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/api/upload.post.ts"),
        [
          'import { requireRateLimit } from "vite-hub/rate-limit"',
          'requireRateLimit(event, "uploads", { enforcement: "strict", failure: "allow", limit: 25, window: "10s" })',
          'throw new Error("The Console must not evaluate Rate Limit modules during discovery.")',
          "",
        ].join("\n"),
      )
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["rate-limits"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/api/_vitehub/console/sections",
        "/_vitehub",
        "/_vitehub/**",
        "/api/_vitehub/console/definitions",
      ])
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).toContain(`from "vite-hub/console/definitions"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["rate-limits"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"rate-limits":[{"fields":[{"label":"Limit","value":"25"},{"label":"Window","value":"10s"},{"label":"Enforcement","value":"Strict"},{"label":"Provider failure","value":"Allow"},{"label":"Source location","value":"2:1"}],"file":"server/api/upload.post.ts","name":"uploads","source":"require-rate-limit"}]})`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not scan host server directories for default Rate Limit discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rate-limit-server-dirs-"))
    const hostServerDir = await mkdtemp(join(tmpdir(), "vitehub-host-server-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(hostServerDir, "upload.ts"), 'requireRateLimit(event, "uploads", { limit: 25, window: "10s" })\n')
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["rate-limits"],
      })
      const config: {
        [VITEHUB_SERVER_DIRS]: string[]
        nitro?: { plugins: string[] }
        root: string
      } = {
        [VITEHUB_SERVER_DIRS]: [hostServerDir],
        root,
      }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])

      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"rate-limits":[]})`)
      expect(generated).not.toContain('"name":"uploads"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(hostServerDir, { force: true, recursive: true })
    }
  })

  it("serializes discovered Schedule timing metadata without loading handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-schedule-host-"))
    try {
      await mkdir(join(root, "server/schedules"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/schedules/adhoc.ts"),
        `export default defineScheduleTarget({ handler() { throw new Error("The Console must not evaluate Schedule Definitions during discovery.") } })\n`,
      )
      await writeFile(
        join(root, "server/schedules/daily.ts"),
        `export default defineSchedule({ cron: "0 0 1 * 1", allowRuntimeSchedules: true, handler() { throw new Error("The Console must not evaluate Schedule Definitions during discovery.") } })\n`,
      )
      await writeFile(
        join(root, "server/schedules/dynamic.ts"),
        `const scheduleCron = process.env.SCHEDULE_CRON || "0 10 * * *"\nexport default defineSchedule({ cron: scheduleCron, handler() {} })\n`,
      )
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["schedules"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/api/_vitehub/console/sections",
        "/_vitehub",
        "/_vitehub/**",
        "/api/_vitehub/console/definitions",
      ])
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).toContain(`from "vite-hub/console/definitions"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["schedules"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"schedules":[{"fields":[{"label":"Kind","value":"Runtime target"},{"label":"Runtime schedules","value":"Allowed"}],"file":"server/schedules/adhoc.ts","name":"adhoc","source":"server-schedules"},{"fields":[{"label":"Kind","value":"Static schedule"},{"label":"Cron","value":"0 0 1 * 1"},{"label":"Time zone","value":"UTC"},{"label":"Runtime schedules","value":"Allowed"}],"file":"server/schedules/daily.ts","name":"daily","source":"server-schedules"},{"fields":[{"label":"Kind","value":"Static schedule"}],"file":"server/schedules/dynamic.ts","name":"dynamic","source":"server-schedules"}]})`)
      expect(generated).toContain(`"file":"server/schedules/dynamic.ts","name":"dynamic","source":"server-schedules"`)
      expect(generated).not.toContain(`"Cron","value":"0 10 * * *"`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("discovers definitions from each service project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-service-roots-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await mkdir(join(root, "packages/database/server/databases"), { recursive: true })
      await mkdir(join(root, "packages/rate-limit/policies"), { recursive: true })
      await mkdir(join(root, "packages/workspace/server/workspaces/docs/workspace"), { recursive: true })
      await mkdir(join(root, "packages/schedule/server/schedules"), { recursive: true })
      await writeFile(join(root, "packages/database/server/databases/config.ts"), "export default defineDatabase({ schema: {} })\n")
      await writeFile(join(root, "packages/rate-limit/policies/api.ts"), 'requireRateLimit(event, "api", { limit: 100, window: "1m" })\n')
      await writeFile(join(root, "packages/workspace/server/workspaces/docs/config.ts"), "export default defineWorkspace({ store: { provider: 'memory' } })\n")
      await writeFile(join(root, "packages/schedule/server/schedules/adhoc.ts"), "export default defineScheduleTarget({ handler() {} })\n")
      const plugins = vitehub({
        console: { exposure: "host-managed" },
        database: { projectRoot: "packages/database" },
        preset: "cloudflare",
        rateLimit: { projectRoot: "packages/rate-limit", scanDirs: ["policies"] },
        schedule: { projectRoot: "packages/schedule" },
        workspace: { projectRoot: "packages/workspace" },
      })
      // SAFETY: Vite plugin options form a recursive array, and this test narrows each flattened candidate structurally before using it as a plugin.
      const pluginCandidates = (plugins as unknown[]).flat(Infinity)
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite plugin options can be nested and mixed at this test boundary, so narrow the flattened value by its plugin name.
      const plugin = pluginCandidates.find((candidate): candidate is Plugin => Boolean(candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/console"))
      if (!plugin) throw new TypeError("Expected the ViteHub Console plugin.")

      await callPluginHook(plugin.config, {}, [{ root }, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [{ root }])

      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('"databases":[{"fields":[{"label":"Mode","value":"Default"},{"label":"Tables","value":"None discovered"}],"file":"packages/database/server/databases/config.ts"')
      expect(generated).toContain('"rate-limits":[{"fields":[{"label":"Limit","value":"100"},{"label":"Window","value":"1m"}')
      expect(generated).toContain('"file":"packages/rate-limit/policies/api.ts","name":"api","source":"require-rate-limit"')
      expect(generated).toContain('"workspaces":[{"fields":[{"label":"Kind","value":"Workspace Definition"}')
      expect(generated).toContain('"file":"packages/workspace/server/workspaces/docs/config.ts","name":"docs"')
      expect(generated).toContain('"schedules":[{"fields":[{"label":"Kind","value":"Runtime target"}')
      expect(generated).toContain('"file":"packages/schedule/server/schedules/adhoc.ts","name":"adhoc"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses the resolved Vite Database root when it replaces a configured service root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-database-override-"))
    const viteRoot = join(projectRoot, "app")
    try {
      await mkdir(join(projectRoot, "packages/api/server/databases"), { recursive: true })
      await mkdir(join(viteRoot, "server/databases"), { recursive: true })
      await writeFile(join(projectRoot, "package.json"), "{}\n")
      await writeFile(join(projectRoot, "packages/api/server/databases/config.ts"), "export default defineDatabase({ schema: {} })\n")
      await writeFile(join(viteRoot, "server/databases/config.ts"), "export default defineDatabase({ schema: {} })\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        databaseDiscoveryRoot: "packages/api",
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["databases"],
      })
      const config: { database?: object; nitro?: { plugins: string[] }; root: string } = { root: viteRoot }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      config.database = {}
      await callPluginHook(plugin.configResolved, {}, [config])

      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain('"file":"app/server/databases/config.ts"')
      expect(generated).not.toContain('"file":"packages/api/server/databases/config.ts"')
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("uses resolved service overrides as complete Console discovery configuration", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-service-overrides-"))
    const viteRoot = join(projectRoot, "app")
    try {
      await mkdir(viteRoot, { recursive: true })
      await writeFile(join(projectRoot, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        databaseDiscoveryRoot: "packages/database",
        preset: "cloudflare",
        rateLimitDiscoveryRoot: "packages/rate-limit",
        rateLimitScanDirs: ["policies"],
        resolveKVStores: () => false,
        sections: ["databases", "rate-limits", "workspaces"],
        workspaceDiscoveryRoot: "packages/workspace",
      })
      const config: {
        database?: false
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        rateLimit?: object
        root: string
        workspace?: object
      } = { root: viteRoot }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      config.database = false
      config.rateLimit = {}
      config.workspace = {}
      await callPluginHook(plugin.configResolved, {}, [config])

      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(projectRoot)}, ["rate-limits","workspaces"])`)
      expect(config.nitro!.handlers.map(handler => handler.route)).toContain("/api/_vitehub/console/definitions")
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("disables standalone Workspace and Sandbox inspection from resolved Vite configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-services-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["sandboxes", "workspaces"],
      })
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
        sandbox?: boolean
        workspace?: boolean
      } = { root, sandbox: true, workspace: true }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers.map(handler => handler.route)).toContain("/api/_vitehub/console/definitions")
      config.sandbox = false
      config.workspace = false
      await callPluginHook(plugin.configResolved, {}, [config])

      expect(config.nitro?.handlers.map(handler => handler.route)).not.toContain("/api/_vitehub/console/definitions")
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, [])`)
      expect(generated).not.toContain("installConsoleDefinitions")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("reconciles disabled services before initial Console discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-initial-disabled-services-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["databases", "sandboxes", "workspaces"],
      })
      const config: {
        database: false
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
        sandbox: false
        workspace: false
      } = { database: false, root, sandbox: false, workspace: false }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).not.toContain("/api/_vitehub/console/definitions")
      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, [])`)
      expect(generated).not.toContain("installConsoleDefinitions")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses each runtime's default discovery root in a nested Vite app", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-root-"))
    const viteRoot = join(projectRoot, "app")
    try {
      await mkdir(join(projectRoot, "server/schedules"), { recursive: true })
      await mkdir(join(projectRoot, "src"), { recursive: true })
      await mkdir(join(viteRoot, "src"), { recursive: true })
      await writeFile(join(projectRoot, "package.json"), "{}\n")
      await writeFile(join(projectRoot, "src/api.ts"), 'requireRateLimit(event, "api", { limit: 100, window: "1m" })\n')
      await writeFile(join(projectRoot, "src/unrelated.sandbox.ts"), "export default defineSandbox({ run: async () => undefined })\n")
      await writeFile(join(viteRoot, "src/preview.sandbox.ts"), "export default defineSandbox({ run: async () => undefined })\n")
      await writeFile(join(projectRoot, "server/schedules/adhoc.ts"), "export default defineScheduleTarget({ handler() {} })\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["rate-limits", "sandboxes", "schedules"],
      })
      const config: { nitro?: { plugins: string[] }; root: string } = { root: viteRoot }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [config])

      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(projectRoot)}`)
      expect(generated).toContain(`"file":"src/api.ts","name":"api","source":"require-rate-limit"`)
      expect(generated).toContain(`"file":"app/src/preview.sandbox.ts","name":"preview","source":"vite-suffix"`)
      expect(generated).not.toContain(`"name":"unrelated"`)
      expect(generated).toContain(`"file":"server/schedules/adhoc.ts","name":"adhoc","source":"server-schedules"`)
      expect(generated).not.toContain(`"file":"../`)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("serializes discovered Sandbox Definition metadata without starting a Sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-sandbox-host-"))
    try {
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "src/preview.sandbox.ts"), `export default defineSandbox({ run: async () => { throw new Error("must not run") } })\n`)
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "cloudflare",
        resolveKVStores: () => false,
        sections: ["sandboxes"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }>; plugins: string[] }; root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [config])

      const generated = await readFile(config.nitro!.plugins[0]!, "utf8")
      expect(generated).toContain(`from "vite-hub/console/sections"`)
      expect(generated).toContain(`from "vite-hub/console/definitions"`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"sandboxes":[{"fields":[{"label":"Kind","value":"Definition"}],"file":"src/preview.sandbox.ts","name":"preview","source":"vite-suffix"}]})`)
      expect(generated).not.toContain("must not run")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("allows host-managed production Console builds on non-Node hosts", async () => {
    const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "cloudflare", sections: ["agents"] })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected a console config hook.")
    const configHandler = "handler" in configHook ? configHook.handler : configHook

    await expect(Reflect.apply(configHandler, {}, [{ root: process.cwd() }, {
      command: "build",
      mode: "production",
    }])).resolves.toBeUndefined()
  })

  it("rejects a bare production Console boolean", async () => {
    const plugin = consoleVitePlugin({ console: true, preset: "node" })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected a console config hook.")
    const configHandler = "handler" in configHook ? configHook.handler : configHook

    await expect(Reflect.apply(configHandler, {}, [{ root: process.cwd() }, {
      command: "build",
      mode: "production",
    }])).rejects.toThrow("console: true is development-only")
  })

  it("requires ViteHub Auth authorize policies for both production route groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-host-"))
    const auth = (routes: ResolvedAuthViteConfig["access"]["routes"]): ResolvedAuthViteConfig => ({
      access: { routes },
      basePath: "/api/auth",
      database: { mode: "default" },
      definition: { handler: "/server/auth.ts", name: "default", source: "server-auth" },
      rootDir: root,
      route: "/api/auth",
      secondaryStorage: false,
    })
    try {
      const missingApi = consoleVitePlugin({
        console: { access: "auth" },
        preset: "node",
        resolveAuthConfig: () => auth([{ authorize: true, route: "/_vitehub/**" }]),
      })
      const missingHook = missingApi.config
      if (!missingHook) throw new TypeError("Expected a console config hook.")
      const missingHandler = "handler" in missingHook ? missingHook.handler : missingHook
      await expect(Reflect.apply(missingHandler, {}, [{ root }, { command: "build", mode: "production" }]))
        .rejects.toThrow("/api/_vitehub/console/**")

      const getOnlyApi = consoleVitePlugin({
        console: { access: "auth" },
        preset: "node",
        resolveAuthConfig: () => auth([
          { authorize: true, route: "/_vitehub/**" },
          { authorize: true, method: "GET", route: "/api/_vitehub/console/**" },
        ]),
      })
      const getOnlyHook = getOnlyApi.config
      if (!getOnlyHook) throw new TypeError("Expected a console config hook.")
      const getOnlyHandler = "handler" in getOnlyHook ? getOnlyHook.handler : getOnlyHook
      await expect(Reflect.apply(getOnlyHandler, {}, [{ root }, { command: "build", mode: "production" }]))
        .rejects.toThrow("/api/_vitehub/console/**")

      const protectedConsole = consoleVitePlugin({
        console: { access: "auth" },
        preset: "node",
        resolveAuthConfig: () => auth([
          { authorize: true, route: "/_vitehub/**" },
          { authorize: true, route: "/api/_vitehub/console/**" },
        ]),
      })
      const protectedHook = protectedConsole.config
      if (!protectedHook) throw new TypeError("Expected a console config hook.")
      const protectedHandler = "handler" in protectedHook ? protectedHook.handler : protectedHook
      const config: { nitro?: { handlers: Array<{ route: string }> }; root: string } = { root }
      await Reflect.apply(protectedHandler, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toEqual(
        expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/**" }), expect.objectContaining({ route: "/api/_vitehub/console/sections" })]),
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("accepts explicit host-managed production exposure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-managed-host-"))
    try {
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "node",
        sections: ["agents"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/**" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps the local console available during development for every preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-dev-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ preset: "cloudflare" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "serve", mode: "development" }])

      expect(config.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("generates a fixture-backed journal only for development servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-host-"))
    const fixtureRoot = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-data-"))
    try {
      const fixture = join(fixtureRoot, "console.fixture.json")
      await writeFile(join(root, "package.json"), "{}\n")
      const fixtureWithPrototypeData = JSON.parse(`{
        "version": 1,
        "invocations": [{
          "createdAt": "2026-08-27T10:00:00.000Z",
          "id": "prototype-data",
          "observations": [{
            "attributes": { "__proto__": { "preserved": true } },
            "name": "agent.message",
            "sequence": 0,
            "timestamp": "2026-08-27T10:00:00.000Z",
            "type": "run"
          }],
          "status": "completed",
          "traceId": "prototype-data-trace",
          "updatedAt": "2026-08-27T10:00:00.000Z"
        }]
      }`)
      await writeFile(fixture, JSON.stringify(fixtureWithPrototypeData))
      vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node", sections: ["agents"] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { plugins?: string[] }, root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "serve", mode: "development" }])
      await callPluginHook(plugin.configResolved, {}, [{ root }])
      await callPluginHook(plugin.buildStart, {})

      const generatedPlugin = config.nitro?.plugins?.[0] ?? ""
      const generated = await readFile(generatedPlugin, "utf8")
      expect(generated).toContain(`installConsoleFixtureInvocations(${JSON.stringify(root)}, ${JSON.stringify(fixture)}, `)
      expect(generated).toContain("JSON.parse(")
      const generatedInstallation = generated.split("\n").find(line => line.startsWith("const vitehubConsoleInvocations"))
      if (!generatedInstallation) throw new TypeError("Expected a generated fixture installation.")
      let generatedSnapshot: unknown
      runInNewContext(generatedInstallation, {
        installConsoleFixtureInvocations: (_root: string, _file: string, snapshot: unknown) => {
          generatedSnapshot = snapshot
        },
      })
      // SAFETY: The generated installation was produced from the fully validated fixture above.
      const generatedAttributes = (generatedSnapshot as { invocations: Array<{ observations: Array<{ attributes: object }> }> })
        .invocations[0]!.observations[0]!.attributes
      expect(Object.hasOwn(generatedAttributes, "__proto__")).toBe(true)
      expect(Reflect.get(generatedAttributes, "__proto__")).toEqual({ preserved: true })

      const listeners = new Map<string, () => Promise<void>>()
      const logger = { error: vi.fn() }
      const add = vi.fn()
      const configureServerHook = plugin.configureServer
      if (!configureServerHook) throw new TypeError("Expected a configureServer hook.")
      const configureServer = "handler" in configureServerHook
        ? configureServerHook.handler
        : configureServerHook
      await Reflect.apply(configureServer, {}, [{ config: { logger }, watcher: { add, on: (event: string, callback: () => Promise<void>) => listeners.set(event, callback) } }])
      expect(add).toHaveBeenCalledWith(fixture)
      await writeFile(fixture, JSON.stringify(fixtureDocument("replacement")))

      const concurrentPlugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node", sections: ["agents"] })
      const concurrentConfig: { nitro?: { plugins?: string[] }, root: string } = { root }
      await callPluginHook(concurrentPlugin.config, {}, [concurrentConfig, { command: "serve", mode: "development" }])
      await callPluginHook(concurrentPlugin.configResolved, {}, [{ root }])
      await callPluginHook(concurrentPlugin.buildStart, {})
      const concurrentGeneratedPlugin = concurrentConfig.nitro?.plugins?.[0] ?? ""
      expect(concurrentGeneratedPlugin).not.toBe(generatedPlugin)
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(generated)
      await expect(readFile(concurrentGeneratedPlugin, "utf8")).resolves.toContain("replacement")

      await listeners.get("change")?.()
      const refreshed = await readFile(generatedPlugin, "utf8")
      expect(refreshed).not.toBe(generated)

      await writeFile(fixture, "not json")
      await expect(listeners.get("change")?.()).resolves.toBeUndefined()
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(refreshed)
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Could not refresh Console development state"))

      await rm(fixture)
      await expect(listeners.get("unlink")?.()).resolves.toBeUndefined()
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(refreshed)
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Could not refresh Console development state"))

      await writeFile(fixture, JSON.stringify(fixtureDocument("restored")))
      await listeners.get("add")?.()
      await expect(readFile(generatedPlugin, "utf8")).resolves.not.toBe(refreshed)

      await expect(Reflect.apply(configHandler, {}, [{ root }, { command: "build", mode: "production" }]))
        .rejects.toThrow("Console fixture mode is development-only")
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(fixtureRoot, { force: true, recursive: true })
    }
  })

  it("does not materialize fixture state when Vite configuration aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-abort-"))
    const fixture = join(root, "console.fixture.json")
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(fixture, JSON.stringify(fixtureDocument("aborted")))
      vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)

      for (const hook of ["config", "configResolved"] as const) {
        const state: ConsoleInvocationRootState = {}
        await expect(createServer({
          configFile: false,
          plugins: [
            consoleVitePlugin({ invocationRootState: state }),
            consoleInvocationRootPlugin(undefined, undefined, state),
            { name: `fixture-${hook}-failure`, [hook]: () => { throw new Error(`${hook} failed`) } },
          ],
          root,
          server: { middlewareMode: true },
        })).rejects.toThrow(`${hook} failed`)

        const generatedPlugin = resolve(root, ".vitehub/nitro/console", `plugin-${state.binding}.mjs`)
        await expect(readFile(generatedPlugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        expect(Reflect.get(process, consoleInvocationsBindingRegistryKey)?.has(state.binding)).not.toBe(true)
        expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey)?.has(root)).not.toBe(true)
        expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: root })).toBeUndefined()
      }
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("ignores inherited fixtures during Vite CLI discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cli-discovery-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const generatedPlugin = resolve(root, ".vitehub/nitro/console/plugin.mjs")
      await mkdir(resolve(generatedPlugin, ".."), { recursive: true })
      await writeFile(generatedPlugin, "// active fixture plugin\n")
      vi.stubEnv(consoleFixtureEnvironmentVariable, join(root, "missing.fixture.json"))
      const plugin = consoleVitePlugin({ preset: "node" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook

      await expect(Reflect.apply(configHandler, {}, [
        { root, vitehubCliDiscovery: true },
        { command: "serve", mode: "development" },
      ])).resolves.toBeUndefined()
      const configResolvedHook = plugin.configResolved
      if (!configResolvedHook) throw new TypeError("Expected a configResolved hook.")
      const configResolvedHandler = "handler" in configResolvedHook ? configResolvedHook.handler : configResolvedHook
      await Reflect.apply(configResolvedHandler, {}, [{ root }])
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe("// active fixture plugin\n")
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("cleans up and restores a refreshed fixture across runtime restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-refresh-close-"))
    const fixture = join(root, "console.fixture.json")
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(fixture, JSON.stringify(fixtureDocument("initial")))
      vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)
      const state: ConsoleInvocationRootState = {}
      const plugin = consoleVitePlugin({ invocationRootState: state, sections: ["agents"] })
      const config: { nitro?: { plugins?: string[] }, root: string } = { root }
      await callPluginHook(plugin.config, {}, [config, { command: "serve", mode: "development" }])
      await callPluginHook(plugin.configResolved, {}, [{ root }])
      await callPluginHook(plugin.buildStart, {})
      const generatedPlugin = config.nitro?.plugins?.[0]
      if (!generatedPlugin) throw new TypeError("Expected a generated Console plugin.")

      const listeners = new Map<string, () => Promise<void>>()
      await callPluginHook(plugin.configureServer, {}, [{
        config: { logger: { error: vi.fn() } },
        watcher: {
          add: vi.fn(),
          on: (event: string, listener: () => Promise<void>) => listeners.set(event, listener),
        },
      }])
      await writeFile(fixture, JSON.stringify(fixtureDocument("replacement")))
      const refresh = listeners.get("change")?.()
      const runtimePlugin = consoleInvocationRootPlugin(root, state.identity, state)
      await callPluginHook(runtimePlugin.closeBundle, {})
      await refresh

      expect(state.closed).toBe(true)
      await expect(readFile(generatedPlugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await listeners.get("change")?.()
      await expect(readFile(generatedPlugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      expect(Reflect.get(process, consoleInvocationsBindingRegistryKey)?.has(state.binding)).toBe(false)
      expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey)?.has(root)).toBe(false)
      expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: root })).toBeUndefined()

      const resolved = { id: "/agent.ts" }
      await callPluginHook(runtimePlugin.buildStart, { resolve: vi.fn().mockResolvedValue(resolved) })
      expect(state.closed).toBe(false)
      await expect(readFile(generatedPlugin, "utf8")).resolves.toContain("replacement")
      const transformed = callPluginHook(runtimePlugin.transform, {}, ["", resolved.id])
      // SAFETY: The generated script returns the isolated realm used by this focused restart test.
      const realm = runInNewContext(`${transformed}\nglobalThis`, { process }) as object
      const invocations = resolveConsoleInvocations(realm)
      if (!invocations) throw new TypeError("Expected the restarted fixture journal.")
      await expect(invocations.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "replacement" })],
      })
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serves discovered Agent names in stable order for the active project", async () => {
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(first, "/first")
    installConsoleAgents(["support", "review", "support"], first)
    installConsoleInvocationFallback(second, "/second")
    installConsoleAgents(["billing"], second)

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["billing"],
    })

    scope[consoleProjectRootKey] = "/first"
    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["review", "support"],
    })
  })

  it("serves Agent names without paging through invocation summaries", async () => {
    const store = createMemoryAgentInvocationStore()
    await store.create({
      agentName: "archived",
      createdAt: "2026-08-31T00:00:00.000Z",
      id: "archived",
      observations: [],
      status: "completed",
      traceId: "archived-trace",
      updatedAt: "2026-08-31T00:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents(["current"], invocations)
    store.list = vi.fn(() => {
      throw new Error("The Console should use the distinct Agent-name index.")
    })

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["archived", "current"],
    })
    expect(store.list).not.toHaveBeenCalled()
  })

  it("serves enabled Console sections in stable order for the active project", () => {
    installConsoleSections("/first", ["agents"])
    installConsoleProjectName("/first", "first-app")
    installConsoleSections("/second", ["kv"])
    installConsoleProjectName("/second", "second-app")

    expect(sectionsHandler(event("127.0.0.1"))).toEqual({
      projectName: "second-app",
      sections: ["kv"],
    })

    scope[consoleSectionsRootKey] = "/first"
    expect(sectionsHandler(event("127.0.0.1"))).toEqual({
      projectName: "first-app",
      sections: ["agents"],
    })
  })

  it("resolves the project name from the process registry across isolated realms", () => {
    installConsoleSections("/project", ["agents"])
    installConsoleProjectName("/project", "shared-app")

    expect(resolveConsoleProjectName({ process })).toBe("shared-app")
  })

  it("does not let section registration rebind the invocation project", () => {
    const first = fakeInvocations("first")
    installConsoleInvocationFallback(first, "/first")

    installConsoleSections("/second", ["kv"])

    expect(resolveConsoleProjectRoot()).toBe("/first")
    expect(resolveConsoleInvocations()).toBe(first)
    expect(sectionsHandler(event("127.0.0.1"))).toEqual({ sections: ["kv"] })
  })

  it("rebinds already evaluated Agent realms to a refreshed fixture revision", async () => {
    const projectRoot = "/project"
    const fixture = "/fixture.json"
    const firstIdentity = createConsoleInvocationsIdentity(projectRoot, fixture, "first")
    const secondIdentity = createConsoleInvocationsIdentity(projectRoot, fixture, "second")
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity, "first")

    const state = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(state, projectRoot, firstIdentity)
    const plugin = consoleInvocationRootPlugin(projectRoot, firstIdentity, state)
    const resolved = { id: "/agent.ts" }
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
    const buildStart = plugin.buildStart as unknown as (this: { resolve: ReturnType<typeof vi.fn> }) => Promise<void>
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
    const transform = plugin.transform as unknown as (code: string, id: string) => string | undefined
    await Reflect.apply(buildStart, { resolve: vi.fn().mockResolvedValue(resolved) }, [])
    const transformed = transform("", resolved.id)
    // SAFETY: The generated script returns the isolated realm used by this focused binding test.
    const realm = runInNewContext(`${transformed}\nglobalThis`, { process }) as object
    expect(resolveConsoleInvocations(realm)).toBe(first)

    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity, "second")
    updateConsoleInvocationRootState(state, projectRoot, secondIdentity)

    expect(resolveConsoleInvocations(realm)).toBe(second)
  })

  it("keeps configured identities across concurrent same-root runtimes", async () => {
    const projectRoot = "/project"
    const firstIdentity = "fixture:/project:/fixture.json:first"
    const secondIdentity = "fixture:/project:/fixture.json:second"
    const thirdIdentity = "fixture:/project:/fixture.json:third"
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const third = fakeInvocations("third")
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity, "first")
    const firstState = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(firstState, projectRoot, firstIdentity)
    const firstPlugin = consoleInvocationRootPlugin(projectRoot, firstIdentity, firstState)
    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity, "second")
    const secondState = { identity: secondIdentity, projectRoot }
    updateConsoleInvocationRootState(secondState, projectRoot, secondIdentity)
    const secondPlugin = consoleInvocationRootPlugin(projectRoot, secondIdentity, secondState)
    const resolved = { id: "/agent.ts" }
    await callPluginHook(firstPlugin.buildStart, { resolve: vi.fn().mockResolvedValue(resolved) })
    await callPluginHook(secondPlugin.buildStart, { resolve: vi.fn().mockResolvedValue(resolved) })

    // SAFETY: Each generated script returns the isolated realm used by this focused binding test.
    const firstRealm = runInNewContext(`${callPluginHook(firstPlugin.transform, {}, ["", resolved.id])}\nglobalThis`, { process }) as object
    // SAFETY: Each generated script returns the isolated realm used by this focused binding test.
    const secondRealm = runInNewContext(`${callPluginHook(secondPlugin.transform, {}, ["", resolved.id])}\nglobalThis`, { process }) as object

    expect(resolveConsoleInvocations(firstRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)

    installConsoleInvocationFallback(third, projectRoot, globalThis, thirdIdentity, "third")
    updateConsoleInvocationRootState(firstState, projectRoot, thirdIdentity)

    expect(resolveConsoleInvocations(firstRealm)).toBe(third)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(firstIdentity)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRevisionRegistryKey).has(firstIdentity)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(secondIdentity)).toBe(true)

    await callPluginHook(secondPlugin.closeBundle, {})
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(secondIdentity)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRevisionRegistryKey).has(secondIdentity)).toBe(false)
  })

  it("retires the current fixture journal when its only runtime closes", async () => {
    const projectRoot = "/project"
    const identity = "fixture:/project:/fixture.json:revision"
    const invocations = fakeInvocations("fixture")
    installConsoleInvocationFallback(invocations, projectRoot, globalThis, identity, "revision")
    const state = { identity, projectRoot }
    updateConsoleInvocationRootState(state, projectRoot, identity)
    const plugin = consoleInvocationRootPlugin(projectRoot, identity, state)

    await callPluginHook(plugin.closeBundle, {})

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).has(projectRoot)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(identity)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRevisionRegistryKey).has(identity)).toBe(false)
    expect(Reflect.has(process, consoleInvocationsKey)).toBe(false)
    expect(resolveConsoleInvocations()).toBeUndefined()
    expect(scope[consoleInvocationsRootKey]).toBeUndefined()
    expect(scope[consoleInvocationsIdentityKey]).toBeUndefined()
    expect(scope[consoleInvocationsIdentityRootKey]).toBeUndefined()
  })

  it("keeps a shared runtime binding until its last server environment closes", async () => {
    const projectRoot = "/project"
    const identity = "fixture:/project:/fixture.json:revision"
    const invocations = fakeInvocations("fixture")
    installConsoleInvocationFallback(invocations, projectRoot, globalThis, identity, "revision")
    const state: ConsoleInvocationRootState = { identity, projectRoot }
    updateConsoleInvocationRootState(state, projectRoot, identity)
    const plugin = consoleInvocationRootPlugin(projectRoot, identity, state)
    const firstEnvironment = { name: "first" }
    const secondEnvironment = { name: "second" }
    const resolved = { id: "/agent.ts" }
    await callPluginHook(plugin.configEnvironment, {}, [firstEnvironment.name, { consumer: "server" }])
    await callPluginHook(plugin.configEnvironment, {}, [secondEnvironment.name, { consumer: "server" }])
    await callPluginHook(plugin.buildStart, { environment: firstEnvironment, resolve: vi.fn().mockResolvedValue(resolved) })
    await callPluginHook(plugin.buildStart, { environment: secondEnvironment, resolve: vi.fn().mockResolvedValue(resolved) })
    const transformed = callPluginHook(plugin.transform, {}, ["", resolved.id])
    // SAFETY: The generated script returns the isolated realm used by this focused environment-lifecycle test.
    const realm = runInNewContext(`${transformed}\nglobalThis`, { process }) as object

    await callPluginHook(plugin.closeBundle, { environment: firstEnvironment })
    expect(state.closed).toBeUndefined()
    expect(resolveConsoleInvocations(realm)).toBe(invocations)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(identity)).toBe(true)

    await callPluginHook(plugin.closeBundle, { environment: secondEnvironment })
    expect(state.closed).toBe(true)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(identity)).toBe(false)
  })

  it("restores a surviving same-root runtime when the current runtime closes", async () => {
    const projectRoot = "/project"
    const firstIdentity = "fixture:/project:/fixture.json:first"
    const secondIdentity = "fixture:/project:/fixture.json:second"
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity, "first")
    const firstState = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(firstState, projectRoot, firstIdentity)
    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity, "second")
    const secondState = { identity: secondIdentity, projectRoot }
    updateConsoleInvocationRootState(secondState, projectRoot, secondIdentity)
    const secondPlugin = consoleInvocationRootPlugin(projectRoot, secondIdentity, secondState)

    await callPluginHook(secondPlugin.closeBundle, {})

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).get(projectRoot)).toBe(firstIdentity)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: projectRoot })).toBe(first)
    expect(resolveConsoleInvocations()).toBe(first)
    expect(Reflect.get(process, consoleInvocationsKey)).toBe(first)
    expect(scope[consoleInvocationsIdentityKey]).toBe(firstIdentity)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(firstIdentity)).toBe(true)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(secondIdentity)).toBe(false)
  })

  it("keeps persisted Agent names alongside discovered definitions", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "archived",
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "archived-invocation",
      observations: [],
      status: "completed",
      traceId: "archived-trace",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents(["current"], invocations)

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["archived", "current"],
    })
  })

  it("uses explicit Agent Definition names instead of discovered route names", async () => {
    const definition = defineAgent({ driver: { run: () => "ok" }, name: " support " })
    expect(definition.name).toBe("support")
    expect(Object.getOwnPropertyDescriptor(definition, "invocations"))
      .toMatchObject({ enumerable: false, get: expect.any(Function), set: expect.any(Function) })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations })

    expect(definition.invocations).toBe(invocations)
    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["support"] })
  })

  it("keeps fallback Agent Definition journals bound to refreshed fixtures", () => {
    const projectRoot = "/project"
    const fixture = "/fixture.json"
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "support" })

    installConsoleInvocationFallback(
      first,
      projectRoot,
      globalThis,
      createConsoleInvocationsIdentity(projectRoot, fixture, "first"),
      "first",
    )
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations: first })
    expect(definition.invocations).toBe(first)

    installConsoleInvocationFallback(
      second,
      projectRoot,
      globalThis,
      createConsoleInvocationsIdentity(projectRoot, fixture, "second"),
      "second",
    )
    expect(definition.invocations).toBe(second)
  })

  it("rebinds Console-owned direct Agent journals while preserving later user assignments", () => {
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const explicit = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition: { invocations?: AgentInvocations, name: string } = { name: "support" }
    const entries = [{ definition: { default: definition }, fallbackName: "help" }]

    installConsoleAgentDefinitions(entries, { invocations: first })
    expect(definition.invocations).toBe(first)

    installConsoleAgentDefinitions(entries, { invocations: second })
    expect(definition.invocations).toBe(second)

    definition.invocations = explicit
    installConsoleAgentDefinitions(entries, { invocations: first })
    expect(definition.invocations).toBe(explicit)
  })

  it("preserves an explicitly configured Agent invocation journal", () => {
    const explicitInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const consoleInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({
      driver: { run: () => "ok" },
      invocations: explicitInvocations,
      name: "support",
    })

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations: consoleInvocations })

    expect(definition.invocations).toBe(explicitInvocations)
  })

  it("installs a discovered Agent invocation journal as the Console journal", async () => {
    const projectRoot = "/configured-journal"
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({
      driver: { run: () => "ok" },
      invocations,
      name: "support",
    })

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { projectRoot })

    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: projectRoot })).toBe(invocations)
    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["support"] })
  })

  it("rejects multiple discovered Agent invocation journals", () => {
    const first = defineAgent({
      driver: { run: () => "ok" },
      invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
      name: "first",
    })
    const second = defineAgent({
      driver: { run: () => "ok" },
      invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
      name: "second",
    })

    expect(() => installConsoleAgentDefinitions([
      { definition: { default: first }, fallbackName: "first" },
      { definition: { default: second }, fallbackName: "second" },
    ], { projectRoot: "/multiple-journals" })).toThrow("Console cannot inspect multiple Agent invocation journals")
  })

  it("preserves an Agent invocation journal assigned after definition", () => {
    const explicitInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const consoleInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "support" })
    definition.invocations = explicitInvocations

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations: consoleInvocations })

    expect(definition.invocations).toBe(explicitInvocations)
  })

  it("uses the discovered name when an explicit Agent Definition name is blank", async () => {
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "   " })
    expect(definition.name).toBe("")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations })

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["help"] })
  })

  it("rejects Agent names beyond the persisted identity limit", () => {
    expect(() => defineAgent({ driver: { run: () => "ok" }, name: "a".repeat(513) }))
      .toThrow("Agent names cannot exceed 512 characters")
  })

  it("keeps colliding discovered route names until definitions resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-collision-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "review.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        console: { exposure: "host-managed" },
        preset: "node",
        sections: ["agents"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated.match(/fallbackName: "review"/g)).toHaveLength(2)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("regenerates discovered Agents when definitions change in development", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-watch-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({ sections: ["agents"] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      await Reflect.apply(configHandler, {}, [{ root }, { command: "serve", mode: "development" }])

      const listeners = new Map<string, () => Promise<void>>()
      const configureServer = plugin.configureServer
      if (!configureServer) throw new TypeError("Expected a console development-server hook.")
      const configureServerHandler = "handler" in configureServer ? configureServer.handler : configureServer
      Reflect.apply(configureServerHandler, {}, [{ watcher: { on: (event: string, listener: () => Promise<void>) => listeners.set(event, listener) } }])

      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      await listeners.get("add")?.()
      await expect(readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8"))
        .resolves.toContain(`fallbackName: "support"`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("finds Agent names beyond the first persisted invocation page", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, agentName] of ["archived", ...Array.from({ length: 100 }, () => "current")].entries()) {
      store.create({
        agentName,
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `inv-${index}`,
        observations: [],
        status: "completed",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents([], invocations)

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["archived", "current"],
    })
  })

  it("filters console sessions by exact Agent name", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const agentName of ["review", "review-assistant"]) {
      store.create({
        agentName,
        createdAt: "2026-08-23T12:00:00.000Z",
        id: agentName,
        observations: [],
        status: "completed",
        traceId: `trace-${agentName}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?agent=review"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    await expect(invocationsHandler(requestEvent)).resolves.toMatchObject({
      invocations: [{ agentName: "review" }],
    })
  })

  it("returns only observations after a matching detail prefix", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "inv-delta",
      observations: [1, 2].map(sequence => ({
        name: "agent.invocation.running",
        sequence,
        timestamp: "2026-08-23T12:00:00.000Z",
        type: "lifecycle" as const,
      })),
      status: "running",
      traceId: "trace-delta",
      updatedAt: "2026-08-23T12:00:03.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const detailURL = "http://localhost/api/_vitehub/console/invocations/inv-delta"
    requestEvent.node!.req!.url = detailURL
    requestEvent.req!.url = detailURL
    const initial = await invocationHandler(requestEvent)
    await store.update("inv-delta", {
      observation: {
        name: "agent.invocation.running",
        sequence: 3,
        timestamp: "2026-08-23T12:00:03.000Z",
        type: "lifecycle",
      },
      timestamp: "2026-08-23T12:00:03.000Z",
    })
    const url = `${detailURL}?observationCount=2&observationCursor=${encodeURIComponent(initial.observationCursor)}`
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    await expect(invocationHandler(requestEvent)).resolves.toMatchObject({
      appendObservations: true,
      invocation: { id: "inv-delta" },
      observations: [{ sequence: 3 }],
    })

    await store.update("inv-delta", {
      observation: {
        name: "agent.invocation.started",
        sequence: 0,
        timestamp: "2026-08-23T11:59:59.000Z",
        type: "lifecycle",
      },
      timestamp: "2026-08-23T12:00:04.000Z",
    })
    const replaced = await invocationHandler(requestEvent)
    expect(replaced.appendObservations).toBeUndefined()
    expect(replaced.observations.map(observation => observation.sequence)).toEqual([0, 1, 2, 3])

    await store.update("inv-delta", {
      observationsTruncated: true,
      timestamp: "2026-08-23T12:00:05.000Z",
    })
    const truncatedURL = `${detailURL}?observationCount=4&observationCursor=${encodeURIComponent(replaced.observationCursor)}`
    requestEvent.node!.req!.url = truncatedURL
    requestEvent.req!.url = truncatedURL
    await expect(invocationHandler(requestEvent)).resolves.not.toHaveProperty("appendObservations")
  })

  it("bounds each console response to the requested page size", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["pending", "pending", "pending", "completed", "completed", "completed"] as const).entries()) {
      store.create({
        createdAt: `2026-08-23T12:00:00.000Z`,
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations.map(invocation => invocation.id)).toEqual(["pending-2", "completed-5"])
    expect(result.cursor).toBeDefined()

    requestEvent.node!.req!.url = `${url}&cursor=${encodeURIComponent(result.cursor!)}`
    requestEvent.req!.url = requestEvent.node!.req!.url
    const next = await invocationsHandler(requestEvent)

    expect(next.invocations.map(invocation => invocation.id)).toEqual(["pending-1", "completed-4"])
    expect(next.cursor).toBeDefined()

    requestEvent.node!.req!.url = `${url}&cursor=${encodeURIComponent(next.cursor!)}`
    requestEvent.req!.url = requestEvent.node!.req!.url
    const last = await invocationsHandler(requestEvent)

    expect(last.invocations.map(invocation => invocation.id)).toEqual(["pending-0", "completed-3"])
    expect(last.cursor).toBeDefined()
  })

  it("caps composite console pages at the invocation list maximum", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 240; index++) {
      const status = index % 2 === 0 ? "pending" : "completed"
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=1000"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toHaveLength(100)
    expect(result.cursor).toBeDefined()
  })

  it("backfills page capacity from a populated lifecycle", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 60; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=50"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toHaveLength(50)
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(50)
    expect(result.invocations.every(invocation => invocation.status === "pending")).toBe(true)
    expect(result.cursor).toBeDefined()
  })

  it("rechecks later lifecycles after backfilling an earlier group", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 6; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending") && ++pendingReads === 2) {
        await store.update("pending-4", {
          status: "running",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return list(options)
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=3"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toContainEqual(expect.objectContaining({
      id: "pending-4",
      status: "running",
    }))
    expect(result.invocations).toHaveLength(3)
    expect(result.cursor).toBeDefined()
    expect(JSON.parse(result.cursor!)).toMatchObject({ queued: "4" })
  })

  it("shares the backfill budget across lifecycle rechecks", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending") && ++pendingReads === 2) {
        for (const index of [6, 7, 8, 9]) {
          await store.update(`pending-${index}`, {
            status: index < 8 ? "running" : "completed",
            timestamp: "2026-08-23T12:01:00.000Z",
          })
        }
      }
      return list(options)
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=6"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toHaveLength(6)
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(6)
    expect(result.invocations.some(invocation => invocation.status === "running")).toBe(true)
    expect(result.invocations.some(invocation => invocation.status === "completed")).toBe(true)
  })

  it("caps replacement lifecycle rechecks to the remaining response budget", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 3; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let queuedRead = false
    let workingRead = false
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending") && !queuedRead) {
        queuedRead = true
        for (let index = 0; index < 3; index++) {
          await store.update(`pending-${index}`, {
            status: "running",
            timestamp: "2026-08-23T12:01:00.000Z",
          })
        }
      }
      else if (Array.isArray(options?.status) && options.status.includes("running") && !workingRead) {
        workingRead = true
        await store.update("pending-2", {
          status: "completed",
          timestamp: "2026-08-23T12:02:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toHaveLength(2)
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(2)
    expect(result.invocations).toContainEqual(expect.objectContaining({
      id: "pending-2",
      status: "completed",
    }))
  })

  it("rechecks later lifecycles after refilling a rolled-back backfill", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        pendingReads++
        if (pendingReads === 2) {
          for (const index of [6, 7, 8, 9]) {
            await store.update(`pending-${index}`, {
              status: index < 8 ? "running" : "completed",
              timestamp: "2026-08-23T12:01:00.000Z",
            })
          }
        }
        if (pendingReads === 3) {
          await store.update("pending-5", {
            status: "running",
            timestamp: "2026-08-23T12:02:00.000Z",
          })
        }
      }
      return list(options)
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=6"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toContainEqual(expect.objectContaining({
      id: "pending-5",
      status: "running",
    }))
    expect(result.invocations).toHaveLength(6)
  })

  it("keeps the cursor produced by the final refill", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    const queuedCursors: (string | undefined)[] = []
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        pendingReads++
        if (pendingReads === 2) {
          for (const index of [6, 7, 8, 9]) {
            await store.update(`pending-${index}`, {
              status: index < 8 ? "running" : "completed",
              timestamp: "2026-08-23T12:01:00.000Z",
            })
          }
        }
        if (pendingReads === 3) {
          await store.update("pending-5", {
            status: "running",
            timestamp: "2026-08-23T12:02:00.000Z",
          })
        }
        if (pendingReads === 4) {
          await store.update("pending-4", {
            status: "running",
            timestamp: "2026-08-23T12:03:00.000Z",
          })
        }
      }
      const result = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        queuedCursors.push(result.cursor)
      }
      return result
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=6"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toHaveLength(6)
    expect(queuedCursors).toHaveLength(4)
    expect(JSON.parse(result.cursor!)).toMatchObject({ queued: queuedCursors.at(-1) })
    expect(result.remainingStatuses).toContain("pending")

    const visited = new Set<string>()
    let cursor = result.cursor
    let transitioned
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      requestEvent.node!.req!.url = `${url}&cursor=${encodeURIComponent(cursor)}`
      requestEvent.req!.url = requestEvent.node!.req!.url
      const next = await invocationsHandler(requestEvent)
      transitioned = next.invocations.find(invocation => invocation.id === "pending-4")
      if (transitioned) break
      cursor = next.cursor
    }

    expect(transitioned).toMatchObject({ id: "pending-4", status: "running" })
  })

  it("preserves an earlier lifecycle cursor when transitions consume its refill", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (!Array.isArray(options?.status) || !options.status.includes("pending")) return list(options)
      pendingReads++
      if (pendingReads === 2) {
        for (const index of [6, 7, 8, 9]) {
          await store.update(`pending-${index}`, {
            status: index < 8 ? "running" : "completed",
            timestamp: "2026-08-23T12:01:00.000Z",
          })
        }
      }
      const page = await list(options)
      if (pendingReads === 3) {
        for (const index of [4, 5]) {
          await store.update(`pending-${index}`, {
            status: "running",
            timestamp: "2026-08-23T12:02:00.000Z",
          })
        }
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=6"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toHaveLength(6)
    expect(JSON.parse(result.cursor!)).toMatchObject({ queued: "5" })
    expect(result.remainingStatuses).toContain("pending")
  })

  it("preserves empty opaque cursors across lifecycle pages", async () => {
    const store = createMemoryAgentInvocationStore()
    const pending = (id: string) => ({
      agentName: undefined,
      createdAt: "2026-08-23T12:00:00.000Z",
      cursor: id,
      id,
      status: "pending" as const,
      traceId: `trace-${id}`,
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const listSpy = vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending") && options.cursor === "") {
        return { invocations: [pending("pending-older")] }
      }
      return Array.isArray(options?.status) && options.status.includes("pending") && options.cursor === undefined
        ? { cursor: "", invocations: [pending("pending-newer")] }
        : { invocations: [] }
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=3"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const first = await invocationsHandler(requestEvent)
    expect(first.invocations.map(invocation => invocation.id)).toEqual(["pending-newer", "pending-older"])
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ cursor: "", status: ["pending"] }))
  })

  it("deduplicates an invocation that becomes terminal between lifecycle reads", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "transitioning",
      observations: [],
      status: "pending",
      traceId: "trace-transitioning",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        await store.update("transitioning", {
          status: "completed",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toMatchObject([{
      id: "transitioning",
      status: "completed",
      updatedAt: "2026-08-23T12:01:00.000Z",
    }])
  })

  it("reclaims page capacity after deduplicating lifecycle reads", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["older", "transitioning"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [],
        status: "pending",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending") && options.cursor === undefined) {
        await store.update("transitioning", {
          status: "completed",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations.map(invocation => invocation.id)).toEqual(["older", "transitioning"])
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(2)
  })

  it("preserves an invocation that becomes terminal between pages", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["transitioning", "newer", "newest"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [],
        status: "running",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const first = await invocationsHandler(requestEvent)
    expect(first.invocations.map(invocation => invocation.id)).toEqual(["newest", "newer"])
    await store.update("transitioning", {
      status: "completed",
      timestamp: "2026-08-23T12:01:00.000Z",
    })

    requestEvent.node!.req!.url = `${url}&cursor=${encodeURIComponent(first.cursor!)}`
    requestEvent.req!.url = requestEvent.node!.req!.url
    let page = await invocationsHandler(requestEvent)
    while (!page.invocations.some(invocation => invocation.id === "transitioning") && page.cursor) {
      requestEvent.node!.req!.url = `${url}&cursor=${encodeURIComponent(page.cursor)}`
      requestEvent.req!.url = requestEvent.node!.req!.url
      page = await invocationsHandler(requestEvent)
    }

    expect(page.invocations).toContainEqual(expect.objectContaining({
      id: "transitioning",
      status: "completed",
      updatedAt: "2026-08-23T12:01:00.000Z",
    }))
  })

  it("reports only terminal lifecycles while the unfiltered history cursor remains", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["running", "pending", "completed"] as const).entries()) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const cursor = encodeURIComponent(JSON.stringify({ history: null }))
    const url = `http://localhost/api/_vitehub/console/invocations?limit=1&cursor=${cursor}`
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.cursor).toBeDefined()
    expect(result.remainingStatuses).toEqual([
      "cancelled",
      "completed",
      "failed",
    ])
  })

  it("keeps an invocation that starts running between lifecycle reads", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "starting",
      observations: [],
      status: "pending",
      traceId: "trace-starting",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        await store.update("starting", {
          status: "running",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)

    expect(result.invocations).toMatchObject([{
      id: "starting",
      status: "running",
      updatedAt: "2026-08-23T12:01:00.000Z",
    }])
  })

  it("continues active pagination after terminal sessions are exhausted", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["completed", "pending", "pending", "pending"] as const).entries()) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const first = await invocationsHandler(requestEvent)
    expect(first.invocations.map(invocation => invocation.id)).toEqual(["pending-3", "completed-0"])
    expect(first.cursor).toBeDefined()

    requestEvent.node!.req!.url = `${url}&cursor=${encodeURIComponent(first.cursor!)}`
    requestEvent.req!.url = requestEvent.node!.req!.url
    const second = await invocationsHandler(requestEvent)
    expect(second.invocations.map(invocation => invocation.id)).toEqual(["pending-2", "pending-1"])
    expect(second.cursor).toBeDefined()
  })

  it("preserves deferred active pagination while serving terminal sessions", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["completed", "completed", "pending", "pending"] as const).entries()) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?limit=1"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const ids: string[] = []
    let cursor: string | undefined
    do {
      requestEvent.node!.req!.url = cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url
      requestEvent.req!.url = requestEvent.node!.req!.url
      const page = await invocationsHandler(requestEvent)
      ids.push(...page.invocations.map(invocation => invocation.id))
      cursor = page.cursor
    } while (cursor)

    expect([...new Set(ids)]).toEqual(["pending-3", "completed-1", "pending-2", "completed-0"])
  })

  it("summarizes recorded usage and marks missing completion evidence unavailable", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "review",
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "usage-invocation",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [
              {
                cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
                model: "model-a",
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              },
              {
                cost: { display: "$0.02", estimated: true, source: "estimated", usd: "0.02" },
                model: "model-b",
                usage: { inputTokens: 8, outputTokens: 7, totalTokens: 15 },
              },
            ],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    store.create({
      completedAt: "2026-08-27T10:30:00.000Z",
      createdAt: "2026-08-27T10:29:00.000Z",
      id: "missing-usage",
      observations: [],
      status: "completed",
      traceId: "trace-missing-usage",
      updatedAt: "2026-08-27T10:30:00.000Z",
    })
    store.create({
      completedAt: "2026-08-28T10:00:00.000Z",
      createdAt: "2026-08-28T10:00:00.000Z",
      id: "future-usage",
      observations: [{
        attributes: { "usage.record": { usage: { totalTokens: 999 } } },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-28T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-future-usage",
      updatedAt: "2026-08-28T10:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })

    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      buckets: expect.arrayContaining([
        expect.objectContaining({
          costAvailable: false,
          costEstimated: true,
          costUsd: "0.03",
          invocations: 2,
          start: "2026-08-27T10:00:00.000Z",
          totalTokens: 30,
          totalTokensAvailable: false,
        }),
      ]),
      costAvailable: false,
      models: [
        { costEstimated: false, costUsd: "0.01", invocations: 1, model: "model-a", totalTokens: 15 },
        { costEstimated: true, costUsd: "0.02", invocations: 1, model: "model-b", totalTokens: 15 },
      ],
      partial: true,
      resolution: "hour",
      totals: {
        costAvailable: false,
        costEstimated: true,
        costUsd: "0.03",
        inputTokens: 18,
        inputTokensAvailable: false,
        invocations: 2,
        outputTokens: 12,
        outputTokensAvailable: false,
        totalTokens: 30,
        totalTokensAvailable: false,
      },
    })
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      buckets: expect.arrayContaining([
        expect.objectContaining({
          costAvailable: true,
          costEstimated: false,
          costUsd: "0",
          invocations: 0,
          start: "2026-08-27T11:00:00.000Z",
          totalTokensAvailable: true,
        }),
      ]),
    })
    expect(invocationUsage((await invocations.get("usage-invocation"))!)).toMatchObject({
      cost: { estimated: true, source: "mixed", usd: "0.03" },
      inputTokens: 18,
      outputTokens: 12,
      totalTokens: 30,
    })
  })

  it("projects cached input tokens from supported usage records", () => {
    const invocation = (usage: Record<string, unknown>) => ({
      createdAt: "2026-08-27T09:59:00.000Z",
      cursor: "cached-usage",
      id: "cached-usage",
      observations: [{
        attributes: { "usage.record": { usage } },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace-cached-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })

    expect(invocationUsage(invocation({ inputTokenDetails: { cachedTokens: 4 } })))
      .toMatchObject({ cachedInputTokens: 4 })
    expect(invocationUsage(invocation({ details: { cachedInputTokens: 6 } })))
      .toMatchObject({ cachedInputTokens: 6 })
  })

  it("keeps incomplete nested usage dimensions unavailable", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "partial-usage",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [
              {
                cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
                model: "priced-input",
                usage: { inputTokens: 10, totalTokens: 10 },
              },
              {
                model: "unpriced-output",
                usage: { outputTokens: 5, totalTokens: 5 },
              },
            ],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-partial-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    const record = (await invocations.get("partial-usage"))!
    const projected = invocationUsage(record)

    expect(projected).toMatchObject({ totalTokens: 15 })
    expect(projected).not.toHaveProperty("cost")
    expect(projected).not.toHaveProperty("inputTokens")
    expect(projected).not.toHaveProperty("outputTokens")
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      costAvailable: false,
      models: [
        expect.objectContaining({ costAvailable: true, model: "priced-input", outputTokensAvailable: false }),
        expect.objectContaining({ costAvailable: false, inputTokensAvailable: false, model: "unpriced-output" }),
      ],
      totals: {
        costAvailable: false,
        inputTokensAvailable: false,
        outputTokensAvailable: false,
        totalTokens: 15,
        totalTokensAvailable: true,
      },
    })
  })

  it("preserves recursive usage evidence and arbitrary decimal scale", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "recursive-usage",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [{
              calls: [
                {
                  cost: { display: "$0.000000000000000000005", estimated: false, source: "provider", usd: "0.000000000000000000005" },
                  model: "leaf-a",
                  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
                },
                {
                  cost: { display: "$0.000000000000000000005", estimated: false, source: "provider", usd: "0.000000000000000000005" },
                  model: "leaf-b",
                  usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
                },
              ],
            }],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-recursive-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    const projected = invocationUsage((await invocations.get("recursive-usage"))!)

    expect(projected).toMatchObject({
      calls: [{ model: "leaf-a" }, { model: "leaf-b" }],
      cost: { usd: "0.00000000000000000001" },
      totalTokens: 15,
    })
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      models: [{ model: "leaf-b" }, { model: "leaf-a" }],
      totals: { costUsd: "0.00000000000000000001", totalTokens: 15 },
    })
  })

  it("does not synthesize complete parent evidence across raw-only calls", async () => {
    const record = {
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T10:00:00.000Z",
      cursor: "raw-only-usage",
      id: "raw-only-usage",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [
              {
                cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              },
              { raw: { requestId: "raw-only" } },
            ],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace-raw-only-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    } satisfies Parameters<typeof invocationUsage>[0]

    const projected = invocationUsage(record)
    expect(projected).not.toHaveProperty("cost")
    expect(projected).not.toHaveProperty("inputTokens")
    expect(projected).not.toHaveProperty("outputTokens")
    expect(projected).not.toHaveProperty("totalTokens")
  })

  it("keeps completed sessions without usage in the no-usage state", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "missing-only",
      observations: [],
      status: "completed",
      traceId: "trace-missing-only",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })

    await expect(createUsageSummary(defineAgentInvocations({ store }), {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: false,
      models: [],
      totals: { costAvailable: false, invocations: 1, totalTokensAvailable: false },
    })
  })

  it("marks truncated finish usage incomplete", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [id, truncated] of [["complete", false], ["truncated", true]] as const) {
      const attributes: Record<string, unknown> = {
        "usage.record": {
          model: id,
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        },
      }
      if (truncated) {
        attributes["vitehub.observation.truncated"] = true
      }
      store.create({
        completedAt: "2026-08-27T10:00:00.000Z",
        createdAt: "2026-08-27T09:59:00.000Z",
        id,
        observations: [{
          attributes,
          name: "agent.invocation.finish",
          sequence: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          type: "lifecycle",
        }],
        status: "completed",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-27T10:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })

    expect(invocationUsage((await invocations.get("truncated"))!)).toBeUndefined()
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      models: [expect.objectContaining({ model: "complete", totalTokens: 10 })],
      partial: true,
      totals: {
        inputTokens: 4,
        inputTokensAvailable: false,
        invocations: 2,
        outputTokens: 6,
        outputTokensAvailable: false,
        totalTokens: 10,
        totalTokensAvailable: false,
      },
    })
  })

  it("scans creation-ordered pages for recent completions", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "long-running-usage",
      observations: [{
        attributes: { "usage.record": { usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } } },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-long-running-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    for (let index = 0; index < 100; index++) {
      store.create({
        completedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-02T00:00:00.000Z",
        id: `old-usage-${index}`,
        observations: [],
        status: "completed",
        traceId: `trace-old-usage-${index}`,
        updatedAt: "2026-01-02T00:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })

    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      partial: false,
      totals: { invocations: 1, totalTokens: 10 },
    })
  })

  it("rejects overlong Agent filters at the usage endpoint", async () => {
    const requestEvent = event("127.0.0.1")
    const url = `http://localhost/api/_vitehub/console/usage?agent=${"a".repeat(513)}`
    if (!requestEvent.node?.req || !requestEvent.req) throw new TypeError("Expected a request event.")
    requestEvent.node.req.url = url
    requestEvent.req.url = url

    await expect(usageHandler(requestEvent)).rejects.toMatchObject({ statusCode: 400 })
  })

  it("keeps the all-Agent usage cache separate from an Agent named star", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = new Date(Date.now() - 1_000).toISOString()
    for (const [agentName, totalTokens] of [["*", 1], ["review", 2]] as const) {
      store.create({
        agentName,
        completedAt: timestamp,
        createdAt: timestamp,
        id: `cache-${agentName}`,
        observations: [{
          attributes: { "usage.record": { usage: { totalTokens } } },
          name: "agent.invocation.finish",
          sequence: 1,
          timestamp,
          type: "lifecycle",
        }],
        status: "completed",
        traceId: `trace-cache-${agentName}`,
        updatedAt: timestamp,
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const allEvent = event("127.0.0.1")
    const starEvent = event("127.0.0.1")
    const allUrl = "http://localhost/api/_vitehub/console/usage"
    const starUrl = "http://localhost/api/_vitehub/console/usage?agent=*"
    allEvent.node!.req!.url = allUrl
    allEvent.req!.url = allUrl
    starEvent.node!.req!.url = starUrl
    starEvent.req!.url = starUrl

    await expect(usageHandler(allEvent)).resolves.toMatchObject({ totals: { totalTokens: 3 } })
    await expect(usageHandler(starEvent)).resolves.toMatchObject({ totals: { totalTokens: 1 } })
  })

  it("searches session text through the console Collection", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "babysitter",
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "matching-invocation",
      observations: [{
        attributes: { "message.content": "The pull request was merged via the queue." },
        name: "agent.message",
        sequence: 1,
        timestamp: "2026-08-23T12:00:00.000Z",
        type: "run",
      }],
      status: "completed",
      traceId: "matching-trace",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    store.create({
      agentName: "review",
      createdAt: "2026-08-23T11:00:00.000Z",
      id: "other-invocation",
      observations: [],
      status: "completed",
      traceId: "other-trace",
      updatedAt: "2026-08-23T11:00:00.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())

    const query = await consoleSearch.parseQuery({ search: "merged via" })
    await expect(consoleSearch.page({ query })).resolves.toEqual({
      items: [{
        agentName: "babysitter",
        context: "matching-invocation",
        excerpt: "The pull request was merged via the queue.",
        id: "matching-invocation",
        status: "completed",
        updatedAt: "2026-08-23T12:00:00.000Z",
      }],
      nextCursor: null,
    })

    // SAFETY: the test mounts the generated Nitro handler on the equivalent H3 route contract.
    const app = new H3().get("/search", searchHandler as never)
    const response = await app.request("/search?limit=12&search=merged%20via")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "matching-invocation" })],
      nextCursor: null,
    })

    const invalidResponse = await app.request("/search?search=one&search=two")
    expect(invalidResponse.status).toBe(400)
  })

  it("accepts persisted Agent names up to the metadata limit", async () => {
    const agentName = "a".repeat(512)
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName,
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "long-name",
      observations: [],
      status: "completed",
      traceId: "trace-long-name",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = `http://localhost/api/_vitehub/console/invocations?agent=${agentName}`
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    await expect(invocationsHandler(requestEvent)).resolves.toMatchObject({
      invocations: [{ agentName }],
    })
  })

  it("refreshes invocation summaries in one request without observations", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["inv-1", "inv-2"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [{ name: "private", sequence: 1, timestamp: "2026-08-23T12:00:00.000Z", type: "run" }],
        status: "running",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const get = vi.spyOn(store, "get")
    const getSummary = vi.spyOn(store, "getSummary")
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?id=inv-1&id=inv-2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    const result = await invocationsHandler(requestEvent)
    expect(result).toMatchObject({
      invocations: [{ id: "inv-1" }, { id: "inv-2" }],
    })
    expect(result).toEqual({
      invocations: [
        expect.not.objectContaining({ observations: expect.anything() }),
        expect.not.objectContaining({ observations: expect.anything() }),
      ],
    })
    expect(getSummary).toHaveBeenCalledTimes(2)
    expect(get).not.toHaveBeenCalled()
  })

  it("supplies the console journal to framework Agent Definitions without a store", () => {
    const fallback = fakeInvocations("console")
    scope[consoleInvocationsKey] = fallback

    const agent = defineAgent({ driver: { run: () => "ok" } })

    expect(agent.invocations).toBe(fallback)
  })

  it("preserves an explicitly configured invocation journal", () => {
    const explicit = fakeInvocations("explicit")
    scope[consoleInvocationsKey] = fakeInvocations("console")

    const agent = defineAgent({ driver: { run: () => "ok" }, invocations: explicit })

    expect(agent.invocations).toBe(explicit)
  })

  it("lets a later invocation journal assignment replace the console fallback", () => {
    scope[consoleInvocationsKey] = fakeInvocations("console")
    const agent = defineAgent({ driver: { run: () => "ok" } })
    const assigned = fakeInvocations("assigned")

    agent.invocations = assigned
    scope[consoleInvocationsKey] = fakeInvocations("replacement")

    expect(agent.invocations).toBe(assigned)
  })

  it("shares the installed journal through the process across module realms", () => {
    const fallback = fakeInvocations("console")
    Reflect.set(process, consoleInvocationsKey, fallback)

    expect(resolveConsoleInvocations({ process })).toBe(fallback)
  })

  it("reads a journal registry created in another module realm", () => {
    const fallback = fakeInvocations("console")
    const foreignRegistry = runInNewContext("new Map()")
    foreignRegistry.set("/project", fallback)
    Reflect.set(process, consoleInvocationsRegistryKey, foreignRegistry)

    expect(
      resolveConsoleInvocations({
        process,
        [consoleProjectRootKey]: "/project",
      }),
    ).toBe(fallback)
  })

  it("resolves the current journal identity from a project-root-only Agent realm", () => {
    const fixture = fakeInvocations("fixture")
    installConsoleInvocationFallback(fixture, "/project", { process }, "fixture:/project:/fixture.json")

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).get("/project")).toBe("fixture:/project:/fixture.json")
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(fixture)
  })

  it("keeps each same-root runtime bound to its installed journal identity", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process }
    const secondScope = { process }

    installConsoleInvocationFallback(first, "/project", firstScope, "fixture:/project:/first.json")
    installConsoleInvocationFallback(second, "/project", secondScope, "fixture:/project:/second.json")

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(second)
  })

  it("keeps concurrent fixture revisions bound to their runtime journal", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process }
    const secondScope = { process }
    const firstIdentity = createConsoleInvocationsIdentity("/project", "/fixture.json", "first-revision")
    const secondIdentity = createConsoleInvocationsIdentity("/project", "/fixture.json", "second-revision")

    installConsoleInvocationFallback(first, "/project", firstScope, firstIdentity, "first-revision")
    installConsoleInvocationFallback(second, "/project", secondScope, secondIdentity, "second-revision")

    const firstAgentRealm = {
      process,
      [consoleInvocationsIdentityKey]: firstIdentity,
      [consoleInvocationsIdentityRootKey]: "/project",
      [consoleInvocationsRootKey]: "/project",
    }
    const secondAgentRealm = {
      process,
      [consoleInvocationsIdentityKey]: secondIdentity,
      [consoleInvocationsIdentityRootKey]: "/project",
      [consoleInvocationsRootKey]: "/project",
    }

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
    expect(resolveConsoleInvocations(firstAgentRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondAgentRealm)).toBe(second)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(second)
  })

  it("keeps process-shared journals scoped to their project root", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process, [consoleProjectRootKey]: "/first" }
    const secondScope = { process, [consoleProjectRootKey]: "/second" }

    installConsoleInvocationFallback(first, "/first", firstScope)
    installConsoleInvocationFallback(second, "/second", secondScope)

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
  })

  it("binds isolated Vite SSR Agent realms to their own project journal", async () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    installConsoleInvocationFallback(first, "/first", { process })
    installConsoleInvocationFallback(second, "/second", { process })
    const firstAgentRealm = { process }
    const secondAgentRealm = { process }
    const unboundAgentRealm = { process }

    // doctor-disable-next-line typescript/evidence/no-object-parameters -- VM contexts accept object realms and the test only checks injected symbol state.
    const bind = async (projectRoot: string, realm: object, identity?: string) => {
      const plugin = consoleInvocationRootPlugin(projectRoot, identity)
      // SAFETY: The console plugin declares this environment predicate on its Vite Plugin contract.
      const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with a focused fake context.
      const buildStart = plugin.buildStart as unknown as (this: typeof context) => Promise<void>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with a focused fake context.
      const resolveId = plugin.resolveId as unknown as (
        // doctor-disable-next-line typescript/evidence/no-object-parameters -- The fake Vite hook context is intentionally structural.
        this: object,
        source: string,
        importer: string | undefined,
        options: { isEntry: boolean },
      ) => Promise<{ external?: boolean, id: string } | undefined>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with focused arguments.
      const transform = plugin.transform as unknown as (
        code: string,
        id: string,
      ) => string | undefined | Promise<string | undefined>
      const resolvedAgentEntry = "/app/node_modules/vite-hub/dist/agent.js"
      const context = {
        error(message: string): never {
          throw new TypeError(message)
        },
        resolve: vi.fn(async () => ({ external: true, id: resolvedAgentEntry })),
      }
      // SAFETY: The focused test inputs provide the only environment field read by the predicate.
      expect(await applyToEnvironment({ config: { consumer: "server" } } as never)).toBe(true)
      // SAFETY: The focused test inputs provide the only environment field read by the predicate.
      expect(await applyToEnvironment({ config: { consumer: "client" } } as never)).toBe(false)
      await Reflect.apply(buildStart, context, [])
      const resolved = await Reflect.apply(resolveId, context, ["vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false }])
      const code = await transform("globalThis.agentModuleEvaluated = true", resolvedAgentEntry)
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", undefined, { skipSelf: true })
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false, skipSelf: true })
      expect(resolved).toEqual({ external: false, id: resolvedAgentEntry })
      // SAFETY: The evaluated fixture explicitly returns its VM global object.
      return runInNewContext(`${code}\nglobalThis`, realm) as object
    }

    expect(Reflect.has(firstAgentRealm, consoleProjectRootKey)).toBe(false)
    expect(Reflect.has(secondAgentRealm, consoleProjectRootKey)).toBe(false)
    expect(resolveConsoleInvocations(unboundAgentRealm)).toBeUndefined()

    const boundFirstAgentRealm = await bind("/first", firstAgentRealm)
    const boundSecondAgentRealm = await bind("/second", secondAgentRealm)

    expect(resolveConsoleInvocations(boundFirstAgentRealm)).toBe(first)
    expect(resolveConsoleInvocations(boundSecondAgentRealm)).toBe(second)
  })

  it("binds same-root isolated Agent realms to their owning runtime journal", async () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const projectRoot = "/project"
    const firstIdentity = "fixture:/project:/first.json"
    const secondIdentity = "fixture:/project:/second.json"
    installConsoleInvocationFallback(first, projectRoot, { process }, firstIdentity)
    installConsoleInvocationFallback(second, projectRoot, { process }, secondIdentity)

    const transform = async (identity: string) => {
      const plugin = consoleInvocationRootPlugin(projectRoot, identity)
      const resolvedAgentEntry = "/app/node_modules/vite-hub/dist/agent.js"
      const context = {
        error(message: string): never { throw new TypeError(message) },
        resolve: vi.fn(async () => ({ external: true, id: resolvedAgentEntry })),
      }
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
      const buildStart = plugin.buildStart as unknown as (this: typeof context) => Promise<void>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
      const transformHook = plugin.transform as unknown as (code: string, id: string) => string
      await Reflect.apply(buildStart, context, [])
      return transformHook("", resolvedAgentEntry)
    }

    // SAFETY: Each generated script returns the isolated realm's global object.
    const firstRealm = runInNewContext(`${await transform(firstIdentity)}\nglobalThis`, { process }) as object
    // SAFETY: Each generated script returns the isolated realm's global object.
    const secondRealm = runInNewContext(`${await transform(secondIdentity)}\nglobalThis`, { process }) as object

    expect(resolveConsoleInvocations(firstRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)
  })

  it("keeps the project-root binding out of client environments", async () => {
    const plugin = consoleInvocationRootPlugin("/private/project")
    // SAFETY: The console plugin declares this environment predicate on its Vite Plugin contract.
    const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with focused arguments.
    const configEnvironment = plugin.configEnvironment as unknown as (
      name: string,
      config: { consumer: "client" | "server" },
    ) => unknown

    // SAFETY: The focused test input provides the only environment field read by the predicate.
    expect(await applyToEnvironment({ config: { consumer: "client" } } as never)).toBe(false)
    expect(configEnvironment("client", { consumer: "client" })).toBeUndefined()
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({ resolve: { noExternal: ["vite-hub"] } })
  })

  it("binds the project root when a real Vite development server loads an Agent realm", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".console-vite-"))
    const projectRoot = join(root, "project")
    const frameworkAgentEntry = createRequire(import.meta.url).resolve("vite-hub/agent")
    await writeFile(
      join(root, "agent-root.ts"),
      [`import ${JSON.stringify(frameworkAgentEntry)}`, 'export const projectRoot = globalThis[Symbol.for("vitehub.console.invocations.root")]', ""].join("\n"),
    )
    let server: Awaited<ReturnType<typeof createServer>> | undefined

    try {
      server = await createServer({
        configFile: false,
        plugins: [consoleInvocationRootPlugin(projectRoot)],
        root,
        server: { middlewareMode: true },
      })
      // SAFETY: The fixture module exports only the projectRoot value asserted below.
      const loaded = await server.ssrLoadModule(join(root, "agent-root.ts")) as { projectRoot?: string }
      expect(loaded.projectRoot).toBe(projectRoot)
    }
    finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("anchors the durable journal to the project root and shares it between runtime instances", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-project-"))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "vitehub-console-cwd-"))
    vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd)
    try {
      const writer = installConsoleInvocations(projectRoot)
      const agent = defineAgent({ driver: { run: () => "persisted" }, runtime: false, version: "1.0.0" })
      await runAgent(agent, runtime("console-cross-realm"), {})

      const reader = createConsoleInvocations(projectRoot)
      const invocation = await reader.getByRunId("console-cross-realm")
      expect(invocation).toMatchObject({ status: "completed" })
      await expect(reader.list({ search: "persisted" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: invocation?.id })],
      })
      expect(invocation?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({
          "vitehub.agent.configuration": expect.objectContaining({
            agent: { version: "1.0.0" },
            driver: { kind: "run" },
            runtime: { name: "unknown" },
          }),
        }),
        name: "vitehub.agent.configured",
      }))
      expect(agent.invocations).toBe(writer)
      expect(existsSync(join(projectRoot, ".vitehub/data/console.sqlite"))).toBe(true)
      expect(existsSync(join(unrelatedCwd, ".vitehub/data/console.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(unrelatedCwd, { force: true, recursive: true })
    }
  })

  it("uses the configured Console database path relative to the project root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-configured-project-"))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "vitehub-console-configured-cwd-"))
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/invocations.sqlite")
    vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd)
    try {
      await createConsoleInvocations(projectRoot).list()

      expect(existsSync(join(projectRoot, "data/invocations.sqlite"))).toBe(true)
      expect(existsSync(join(projectRoot, ".vitehub/data/console.sqlite"))).toBe(false)
      expect(existsSync(join(unrelatedCwd, "data/invocations.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(unrelatedCwd, { force: true, recursive: true })
    }
  })

  it("decodes configured relative Console database file URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-encoded-project-"))
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/my%20journal%231.sqlite")
    try {
      const databasePath = join(projectRoot, "data/my journal#1.sqlite")
      expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({ url: pathToFileURL(databasePath).href })
      await createConsoleInvocations(projectRoot).list()

      expect(existsSync(databasePath)).toBe(true)
      expect(existsSync(join(projectRoot, "data/my%20journal%231.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves absolute Console database file URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-file-url-project-"))
    const databasePath = join(await mkdtemp(join(tmpdir(), "vitehub-console-file-url-data-")), "console #1.sqlite")
    const databaseUrl = pathToFileURL(databasePath).href
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)
    try {
      expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({ url: databaseUrl })
      await createConsoleInvocations(projectRoot).list()

      expect(existsSync(databasePath)).toBe(true)
      expect(existsSync(join(projectRoot, "console.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(dirname(databasePath), { force: true, recursive: true })
    }
  })

  it("recognizes one-slash absolute Console database file URLs", () => {
    const databasePath = join(tmpdir(), "vitehub-console-one-slash", "console.sqlite")
    const databaseUrl = pathToFileURL(databasePath).href.replace("file:///", "file:/")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)

    expect(resolveConsoleDatabaseOptions(join(tmpdir(), "vitehub-console-project"))).toEqual({
      url: pathToFileURL(databasePath).href,
    })
  })

  it("resolves Console database file URL schemes case-insensitively", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-uppercase-scheme-project")
    const relativeDatabasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "FILE:data/invocations.sqlite")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: pathToFileURL(relativeDatabasePath).href,
    })

    const absoluteDatabasePath = join(tmpdir(), "vitehub-console-uppercase-scheme", "console.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", pathToFileURL(absoluteDatabasePath).href.replace("file:", "FILE:"))

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: pathToFileURL(absoluteDatabasePath).href,
    })
  })

  it("preserves query parameters on configured Console database file URLs", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-query-project")
    const databasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/invocations.sqlite?mode=rwc")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: `${pathToFileURL(databasePath).href}?mode=rwc`,
    })
  })

  it("excludes fragments from configured relative Console database file paths", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-fragment-project")
    const databasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/invocations.sqlite?mode=rwc#journal")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: `${pathToFileURL(databasePath).href}?mode=rwc`,
    })
  })

  it("preserves configured in-memory Console database URLs", async () => {
    const databaseUrl = "file::memory:?cache=shared"
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)

    expect(resolveConsoleDatabaseOptions(process.cwd())).toEqual({ url: databaseUrl })
    await expect(createConsoleInvocations(process.cwd()).list()).resolves.toMatchObject({ invocations: [] })
  })

  it("recognizes percent-encoded in-memory Console database URLs", () => {
    const databaseUrl = "file:%3Amemory%3A?cache=shared"
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)

    expect(resolveConsoleDatabaseOptions(process.cwd())).toEqual({ url: databaseUrl })
  })

  it("resolves Console database paths that begin with the in-memory name", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-memory-prefix-project")
    const databasePath = join(projectRoot, ":memory:backup.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file::memory:backup.sqlite")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({ url: pathToFileURL(databasePath).href })
  })

  it("configures the Console database authentication token", () => {
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "libsql://console.example.com")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN", "console-token")

    expect(resolveConsoleDatabaseOptions(process.cwd())).toEqual({
      authToken: "console-token",
      url: "libsql://console.example.com",
    })
  })

  it("preserves progress summaries in the console journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-progress-"))
    try {
      installConsoleInvocations(projectRoot)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield {
              data: { revision: 2, summary: "Checking Airtable for assigned tasks.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgent(agent, runtime("console-progress-summary"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await createConsoleInvocations(projectRoot).getByRunId("console-progress-summary")
      expect(invocation?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({
          "content.omitted": expect.not.arrayContaining(["tool.output"]),
          "tool.output": expect.anything(),
          "vitehub.activity.progress": "Checking Airtable for assigned tasks.",
        }),
        name: "agent.tool.finish",
      }))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves failed tool payloads in the console journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-tool-error-"))
    try {
      installConsoleInvocations(projectRoot)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield { id: "tool-1", input: { query: "missing" }, name: "lookup", type: "tool-call" }
            yield { error: "Lookup failed", id: "tool-1", name: "lookup", type: "tool-result" }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgent(agent, runtime("console-tool-error"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await createConsoleInvocations(projectRoot).getByRunId("console-tool-error")
      const observation = invocation?.observations.find(item => item.name === "agent.tool.error")
      expect(observation).toEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "tool.error": "Lookup failed" }),
        name: "agent.tool.error",
      }))
      expect(observation?.attributes?.["content.omitted"] ?? []).not.toContain("tool.error")
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves tool payloads in fixture-backed console journals", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-tools-"))
    try {
      const file = join(projectRoot, "console.fixture.json")
      await writeFile(file, JSON.stringify({ invocations: [], version: 1 }))
      const invocations = installConsoleFixtureInvocations(projectRoot, file)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield { id: "tool-1", input: { query: "fixture" }, name: "lookup", type: "tool-call" }
            yield { id: "tool-1", name: "lookup", output: { answer: "preserved" }, type: "tool-result" }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgent(agent, runtime("console-fixture-tool"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await invocations.getByRunId("console-fixture-tool")
      expect(invocation?.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ "tool.input": { query: "fixture" } }),
          name: "agent.tool.start",
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "tool.output": { answer: "preserved" } }),
          name: "agent.tool.finish",
        }),
      ]))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("accepts public read-only requests", () => {
    expect(() => assertConsoleRequest(event("203.0.113.2"))).not.toThrow()
    expect(() => assertConsoleRequest(event(undefined))).not.toThrow()
  })

  it("marks every console API response as non-cacheable and non-indexable", () => {
    const responseHeaders = new Map<string, string>()
    const requestEvent = event("127.0.0.1")
    requestEvent.node!.res = {
      setHeader: (name, value) => responseHeaders.set(name, value),
    }

    assertConsoleRequest(requestEvent)

    expect(responseHeaders).toEqual(new Map([
      ["cache-control", "no-store"],
      ["x-content-type-options", "nosniff"],
      ["x-robots-tag", "noindex, nofollow"],
    ]))
  })

  it("serves the standalone shell with build-replaceable assets and a restrictive non-cacheable policy", async () => {
    const response = consolePageHandler(event("127.0.0.1"))
    const page = await response.text()

    expect(page).toContain("/_vitehub/assets/__VITEHUB_CONSOLE_STYLE_ASSET__")
    expect(page).toContain("/_vitehub/assets/__VITEHUB_CONSOLE_SCRIPT_ASSET__")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("content-security-policy")).toContain("base-uri 'none'")
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'")
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
  })

  it("rejects non-GET console requests", () => {
    expect(() => assertConsoleRequest(event("127.0.0.1", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
  })
})
