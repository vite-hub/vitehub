import { describe, expect, it } from "vitest"
import * as v from "valibot"

import { createSourceContext, createRuntimeRegistry, resolveEnvEntries } from "../src/core/resolve.ts"
import { env } from "../src/core/declarations.ts"
import { SecretEnv } from "../src/secret.ts"
import { bindServerEnvSchemas, describeServerEnv, inspectServerEnv, resolveServerEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"

function capture(operation: () => unknown): unknown {
  try {
    operation()
  }
  catch (error) {
    return error
  }
  throw new Error("Expected operation to throw")
}

function listRegistry() {
  return createRuntimeRegistry({
    allowedDomains: env.list({ source: env.source("ALLOWED_DOMAINS") }),
    channels: env.list(env.enum(["email", "slack"]), { default: ["email"], source: env.source("CHANNELS") }),
    ports: env.list(env.number(), { optional: true, source: env.source("PORTS") }),
    tokens: env.list({ secret: true, source: env.source("TOKENS") }),
  })
}

describe("env.list()", () => {
  it("splits on commas and line breaks, trims items, drops empty items, and parses each item", () => {
    const values = resolveServerEnv<{ allowedDomains: string[], channels: string[], ports?: number[], tokens: SecretEnv<string[]> }>(listRegistry(), cloudflareRequest({
      ALLOWED_DOMAINS: " a.example , b.example,,  ,c.example ",
      CHANNELS: "slack\r\nemail\n",
      PORTS: "80, 443",
      TOKENS: "one,two words",
    }))
    expect(values.allowedDomains).toEqual(["a.example", "b.example", "c.example"])
    expect(values.channels).toEqual(["slack", "email"])
    expect(values.ports).toEqual([80, 443])
    expect(values.tokens).toBeInstanceOf(SecretEnv)
    expect(values.tokens.unseal()).toEqual(["one", "two words"])
  })

  it("uses the default and reads a value of only commas as an empty list", () => {
    const values = resolveServerEnv(listRegistry(), cloudflareRequest({ ALLOWED_DOMAINS: ",", TOKENS: "x" }))
    expect(values).toMatchObject({ allowedDomains: [], channels: ["email"], ports: undefined })
  })

  it("gives each call its own array", () => {
    const registry = listRegistry()
    const request = cloudflareRequest({ ALLOWED_DOMAINS: "a", TOKENS: "x" })
    const first = resolveServerEnv<{ allowedDomains: string[] }>(registry, request)
    first.allowedDomains.push("mutated")
    expect(resolveServerEnv<{ allowedDomains: string[] }>(registry, request).allowedDomains).toEqual(["a"])
  })

  it("names the item that fails and keeps secret items out of errors", () => {
    const error = capture(() => resolveServerEnv(listRegistry(), cloudflareRequest({ ALLOWED_DOMAINS: "a", PORTS: "80, http", TOKENS: "x" })))
    expect(error).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { path: "env.server.ports" } })
    expect(String((error as Error).cause)).toContain("Item 2: Expected a finite number.")

    const secret = createRuntimeRegistry({ pins: env.list(env.number(), { secret: true, source: env.source("PINS") }) })
    const hidden = capture(() => resolveServerEnv(secret, cloudflareRequest({ PINS: "12, secret-pin" })))
    expect(hidden).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID" })
    expect(JSON.stringify(hidden) + String((hidden as Error).cause)).not.toContain("secret-pin")
  })

  it("describes the item type for the Console and deploy listing", () => {
    expect(describeServerEnv(listRegistry()).entries.map(entry => [entry.path, entry.type, entry.names])).toEqual([
      ["env.server.allowedDomains", "Array<string>", ["VITEHUB_ALLOWED_DOMAINS", "ALLOWED_DOMAINS"]],
      ["env.server.channels", "Array<\"email\" | \"slack\">", ["VITEHUB_CHANNELS", "CHANNELS"]],
      ["env.server.ports", "Array<number>", ["VITEHUB_PORTS", "PORTS"]],
      ["env.server.tokens", "Array<string>", ["VITEHUB_TOKENS", "TOKENS"]],
    ])
  })

  it("checks the default and rejects a secret enum list", () => {
    expect(capture(() => createRuntimeRegistry({ ports: env.list(env.number(), { default: ["http"] as never }) })))
      .toMatchObject({ code: "ENV_R0023" })
    expect(capture(() => createRuntimeRegistry({ ports: env.list(env.number(), { default: "80" as never }) })))
      .toMatchObject({ code: "ENV_R0023" })
    const error = capture(() => createRuntimeRegistry({ channels: env.list(env.enum(["email"]), { secret: true }) }))
    expect(String((error as Error).cause)).toContain("cannot be a secret enum")
  })

  it("rejects an item parser with options", () => {
    expect(capture(() => env.list(env.number({ default: 1 })))).toMatchObject({ code: "ENV_LIST_ITEM_INVALID" })
    expect(capture(() => env.list(env.list()))).toMatchObject({ code: "ENV_LIST_ITEM_INVALID" })
    expect(capture(() => env.list({} as never, {}))).toMatchObject({ code: "ENV_LIST_ITEM_INVALID" })
  })
})

describe("env.json()", () => {
  const Settings = v.object({ labels: v.array(v.string()), threshold: v.number() })

  function settingsRegistry() {
    const registry = createRuntimeRegistry({
      raw: env.json({ default: { enabled: true }, source: env.source("RAW") }),
      settings: env.json(env.schemaFrom("./server/env.schema.ts", "settings"), { source: env.source("SETTINGS") }),
      credentials: env.json(env.schemaFrom("./server/env.schema.ts", "settings"), { optional: true, secret: true, source: env.source("CREDENTIALS") }),
    }, { schemaModules: true })
    bindServerEnvSchemas(registry, { "./server/env.schema.ts": { settings: Settings } })
    return registry
  }

  it("parses JSON and validates it with the schema from a module", () => {
    const values = resolveServerEnv<{ raw: unknown, settings: v.InferOutput<typeof Settings> }>(settingsRegistry(), cloudflareRequest({
      RAW: "[1, \"two\", null]",
      SETTINGS: "{\"labels\":[\"a\"],\"threshold\":0.5}",
    }))
    expect(values.raw).toEqual([1, "two", null])
    expect(values.settings).toEqual({ labels: ["a"], threshold: 0.5 })
    expect(resolveServerEnv(settingsRegistry(), cloudflareRequest({ SETTINGS: "{\"labels\":[],\"threshold\":1}" }))).toMatchObject({ raw: { enabled: true } })
  })

  it("rejects text that is not JSON and values that fail the schema", async () => {
    const malformed = capture(() => resolveServerEnv(settingsRegistry(), cloudflareRequest({ SETTINGS: "{labels:" })))
    expect(malformed).toMatchObject({ code: "ENV_RUNTIME_VALUE_INVALID", details: { path: "env.server.settings" } })
    expect(String((malformed as Error).cause)).toContain("Expected valid JSON.")

    const mismatch = capture(() => resolveServerEnv(settingsRegistry(), cloudflareRequest({ SETTINGS: "{\"labels\":\"a\",\"threshold\":1}" })))
    expect(String((mismatch as Error).cause)).toContain("labels")

    const secret = capture(() => resolveServerEnv(settingsRegistry(), cloudflareRequest({ CREDENTIALS: "{\"labels\":\"private-label\"}", SETTINGS: "{\"labels\":[],\"threshold\":1}" })))
    expect(String((secret as Error).cause)).toContain("The value does not match its schema.")
    expect(JSON.stringify(secret) + String((secret as Error).cause)).not.toContain("private-label")

    const inspection = await inspectServerEnv(settingsRegistry(), cloudflareRequest({ RAW: "nope", SETTINGS: "{}" }))
    expect(inspection.entries.map(entry => [entry.path, entry.status])).toEqual([
      ["env.server.raw", "invalid"],
      ["env.server.settings", "invalid"],
      ["env.server.credentials", "missing"],
    ])
  })

  it("reads a string default as JSON text", () => {
    const registry = createRuntimeRegistry({ value: env.json({ default: "{\"a\":1}", source: env.source("VALUE") }) })
    expect(resolveServerEnv(registry, cloudflareRequest({}))).toEqual({ value: { a: 1 } })
    expect(capture(() => createRuntimeRegistry({ value: env.json({ default: "plain text" }) }))).toMatchObject({ code: "ENV_R0023" })
  })

  it("describes the type and asks for env.schemaFrom() in env.server", () => {
    expect(describeServerEnv(settingsRegistry()).entries.map(entry => entry.type)).toEqual(["unknown", "unknown", "unknown"])
    expect(capture(() => env.json(Settings))).toMatchObject({ code: "ENV_JSON_SCHEMA_INVALID" })
    expect(capture(() => env.json({ kind: "other" } as never))).toMatchObject({ code: "ENV_JSON_SCHEMA_INVALID" })
  })

  it("runs a schema object for build-time values", async () => {
    const declarations = {
      settings: env.json(Settings, { mode: "build", source: env.source("SETTINGS") }),
      origins: env.list({ mode: "build", source: env.source("ORIGINS") }),
    }
    const context = createSourceContext({ env: { ORIGINS: "a, b", SETTINGS: "{\"labels\":[\"x\"],\"threshold\":2}" }, mode: "build", rootDir: process.cwd() })
    const { entries } = await resolveEnvEntries(declarations, { context, exposure: "build public", section: "env.public", timing: "build" })
    expect(Object.fromEntries(entries.map(entry => [entry.key, entry.value]))).toEqual({ origins: ["a", "b"], settings: { labels: ["x"], threshold: 2 } })

    const invalid = createSourceContext({ env: { ORIGINS: "a", SETTINGS: "not json" }, mode: "build", rootDir: process.cwd() })
    await expect(resolveEnvEntries(declarations, { context: invalid, exposure: "build public", section: "env.public", timing: "build" }))
      .rejects.toMatchObject({ code: "ENV_R0015" })
  })
})
