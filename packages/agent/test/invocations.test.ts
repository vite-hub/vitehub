import { hasRuntimeType, isRuntimeRecord } from "../src/internal/runtime-type.ts"
import { createClient } from "@libsql/client"
import { createTraceEventLog, deriveTraceRuns, traceEventsToOpenTelemetrySpans } from "@vite-hub/runtime"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it, vi } from "vitest"

import { agentInvocationId, defineAgent, defineCapability, runAgent, runAgentInline, streamAgent } from "../src/index.ts"
import * as invocationModule from "../src/invocations.ts"
import { applyAgentInvocationStoreUpdate, bindAgentInvocations, byteBoundedObservations, observationLimits } from "../src/invocations.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStore } from "../src/server.ts"
import type { Client } from "@libsql/client"

const outcomeObservationNames = new Set(["agent.invocation.finish", "agent.stream.error"])

function runtime(runId: string, annotations?: Record<string, boolean | number | string | null>) {
  return {
    memo: vi.fn(),
    run: { annotations, runId },
    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

function inspectableToolCapability() {
  return defineCapability({
    id: "search",
    tools: {
      search: {
        description: "Search indexed records.",
        inputSchema: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        name: "search",
      },
    },
  })
}

describe("Agent Invocations", () => {
  it.each(["API_TOKEN ?=", "PASSWORD +=", "--api-token?=", "'PASSWORD' +="])("redacts compound assignments across forced flushes: %s", async (prefix) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of prefix + "sensitive-value;status=ok") {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "compound", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("compound"), {})
    const observations = (await invocations.getByRunId("compound"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(prefix + "[REDACTED];status=ok")
    expect(JSON.stringify(observations)).not.toContain("sensitive-value")
  })

  it.each(["|", ">-"])("preserves ordinary YAML %s scalar content across forced flushes", async (style) => {
    const text = `message: ${style}\n  password: "ordinary words"\n  secret: ordinary text\npassword: sensitive-value\nstatus: ok`
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of text) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "scalar-prose", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("scalar-prose"), {})
    const observations = (await invocations.getByRunId("scalar-prose"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(text.replace("sensitive-value", "[REDACTED]"))
    expect(JSON.stringify(observations)).not.toContain("sensitive-value")
  })

  it.each([
    ["{password: ", "}"],
    ["config: {password: ", ", status: ok}"],
    ["{status: ok, secret: ", "}"],
  ])("redacts YAML flow mapping values across forced flushes: %s", async (prefix, suffix) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of prefix + "sensitive value" + suffix) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "flow-yaml", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("flow-yaml"), {})
    const observations = (await invocations.getByRunId("flow-yaml"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(prefix + "[REDACTED]" + suffix)
    expect(JSON.stringify(observations)).not.toContain("sensitive value")
  })

  it.each([
    "password:\nstatus: ok",
    "password: \nstatus: ok",
    "password: # optional\nstatus: ok",
    "config:\n  secret: \r\n  status: ok",
  ])("preserves empty YAML values across forced flushes: %s", async (text) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of text) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "empty-yaml", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("empty-yaml-credential"), {})
    const observations = (await invocations.getByRunId("empty-yaml-credential"))!.observations
    expect(observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")).toBe(text)
  })

  it.each([
    ["\nstatus: ok", "\nstatus: ok"],
    [" # optional\nstatus: ok", " # optional\nstatus: ok"],
    [" sensitive-value\nstatus: ok", " [REDACTED]\nstatus: ok"],
    [' "sensitive-value"\nstatus: ok', ' "[REDACTED]"\nstatus: ok'],
  ])("emits empty YAML prefixes before tool events: %s", async (suffix, expected) => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "yaml-order", "message.content": "password:" } })
        await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "yaml-order", "message.content": suffix } })
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("yaml-order"), {})
    const observations = (await invocations.getByRunId("yaml-order"))!.observations
    const events = observations.filter(entry => entry.name === "agent.message.delta" || entry.name === "tool.call")
    expect(events.slice(0, 2).map(entry => [entry.name, entry.attributes?.["message.content"]]))
      .toEqual([["agent.message.delta", "password:"], ["tool.call", undefined]])
    expect(events.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join(""))
      .toBe("password:" + expected)
    expect(JSON.stringify(observations)).not.toContain("sensitive-value")
  })

  it.each([
    ["password: ", "correct horse battery", "\nstatus: ok"],
    ["api_token: ", "sensitive value", " # public comment\nstatus: ok"],
    ["config:\n  password: ", "correct horse\n    battery\n\n   staple", "\n  status: ok"],
    ["  - secret: ", "sensitive value\n      more secret", "\n    status: ok"],
    ["password: ", 'sensitive#value,with;shell&punctuation<> and "quotes"', "\nstatus: ok"],
  ])("redacts plain YAML scalars across forced message flushes: %s", async (prefix, credential, suffix) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of [prefix, ...credential + suffix]) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "plain-yaml", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("plain-yaml-credential"), {})
    const observations = (await invocations.getByRunId("plain-yaml-credential"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(prefix + "[REDACTED]" + suffix)
    expect(JSON.stringify(observations)).not.toMatch(/correct|horse|battery|staple|sensitive|more secret/)
  })

  it("flushes interleaved message identities and safe text before tool events", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const [id, text] of [["a", "A1"], ["b", "B1"], ["a", "A2"], ["c", "This is a"]]) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": id, "message.content": text } })
        }
        await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("interleaved-messages"), {})
    const observations = (await invocations.getByRunId("interleaved-messages"))!.observations
    expect(observations.filter(entry => entry.name === "agent.message.delta" || entry.name === "tool.call")
      .map(entry => [entry.name, entry.attributes?.["message.content"]]))
      .toEqual([
        ["agent.message.delta", "A1"],
        ["agent.message.delta", "B1"],
        ["agent.message.delta", "A2"],
        ["agent.message.delta", "This is a"],
        ["tool.call", undefined],
      ])
  })

  it.each([
    ["pass", "word=sensitive-value", "password=[REDACTED]"],
    ["Author", "ization: Bearer sensitive-value", "Authorization: Bearer [REDACTED]"],
  ])("keeps emitted marker context across tool events: %s", async (prefix, suffix, expected) => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const text of [prefix, suffix]) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "split-marker", "message.content": text } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("split-marker"), {})
    const observations = (await invocations.getByRunId("split-marker"))!.observations
    const messagesAndTools = observations.filter(entry => entry.name === "agent.message.delta" || entry.name === "tool.call")
    expect(messagesAndTools.slice(0, 2).map(entry => [entry.name, entry.attributes?.["message.content"]]))
      .toEqual([["agent.message.delta", prefix], ["tool.call", undefined]])
    expect(messagesAndTools.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join(""))
      .toBe(expected)
    expect(JSON.stringify(observations)).not.toContain("sensitive-value")
  })

  it.each([
    ["Authorization: ", "ghp_sensitive", ";status=ok"],
    ["Authorization: ", "ghp_sensitive status=private", "\nstatus=ok"],
    ["Authorization: ", "x".repeat(300), "\nstatus=ok"],
    ["Proxy-Authorization: ", "raw-token+/=", "\nstatus=ok"],
    ['{"authorization":"', "sensitive-value", '", "status":"ok"}'],
    ["Authorization: token ", "ghp_sensitive", ";status=ok"],
    ["Authorization: ApiKey ", "sensitive-value", "\nstatus=ok"],
    ["Proxy-Authorization: Digest ", 'username="private", realm="hidden", response="sensitive"', ";status=ok"],
    ['{"authorization":"', "Custom-Auth sensitive-value", '", "status":"ok"}'],
  ])("redacts bounded custom authorization headers: %s", async (prefix, credential, suffix) => {
    const invocations = defineAgentInvocations({
      content: "content",
      // Every character also emits a tool event. Keep the complete test trace.
      observations: { maxCount: 1024 },
      store: createMemoryAgentInvocationStore(),
    })
    const padding = ".".repeat(512)
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of [padding, ...(prefix + credential + suffix)]) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "custom-auth", "message.content": character } })
          // Force each retained header fragment through an intervening-event flush.
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("custom-authorization"), {})
    const observations = (await invocations.getByRunId("custom-authorization"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(padding + prefix + "[REDACTED]" + suffix)
  })

  it.each([
    '{"d":"sensitive"}',
    '["first-secret","second-secret"]',
    '[{"d":"sensitive"},["other-secret"]]',
    '{]"d":"sensitive"}',
    '[}"sensitive"]',
    '{"nested":[{"d":"escaped\\\"} ] secret"},["other-secret"]]}',
  ])("redacts structured credentials across forced message flushes: %s", async (credential) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const prefix = '{"privateKey":'
    const suffix = ',"status":"ok"}'
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of prefix + credential + suffix) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "structured", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("structured-credential"), {})
    const observations = (await invocations.getByRunId("structured-credential"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(prefix + "[REDACTED]" + suffix)
    expect(JSON.stringify(observations)).not.toMatch(/sensitive|first-secret|second-secret|other-secret/)
  })

  it.each(["password", "secret"].flatMap(key => ["characters", "events"].map(boundary => ({ key, boundary }))))("redacts YAML list $key after a $boundary flush", async ({ key, boundary }) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxStringLength: 128 }, store: createMemoryAgentInvocationStore() })
    const prefix = `${boundary === "characters" ? ".".repeat(512) + "\n" : ""}config:\n  - `
    const agent = defineAgent({
      driver: { async run(context) {
        const chunks = [
          ...(boundary === "events" ? Array.from({ length: 31 }, () => "") : []),
          prefix,
          `${key}: "sensitive-value"\n    status: ok\n`,
        ]
        for (const chunk of chunks) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "yaml-list", "message.content": chunk } })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("yaml-list"), {})
    const observations = (await invocations.getByRunId("yaml-list"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(`${prefix}${key}: "[REDACTED]"\n    status: ok\n`)
    expect(JSON.stringify(observations)).not.toContain("sensitive-value")
  })

  it.each(["api_token", "password", "secret"].flatMap(key => ["|", ">-", "|2-", "&credential |", "!!str >-", "&credential !!str |2-", "!<tag:yaml.org,2002:str> &credential >"].map(indicator => ({ key, indicator }))))("redacts YAML $key scalar $indicator across forced message flushes", async ({ key, indicator }) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxCount: 1024 }, store: createMemoryAgentInvocationStore() })
    const text = `config:\n  ${key}: ${indicator}\n    sensitive-value\n    more-secret\n  status: ok\n`
    const agent = defineAgent({
      driver: { async run(context) {
        for (const character of text) {
          await context.traceLog?.append({ name: "agent.message.delta", type: "run", attributes: { "message.id": "yaml", "message.content": character } })
          await context.traceLog?.append({ name: "tool.call", type: "run", attributes: {} })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("yaml-scalar"), {})
    const observations = (await invocations.getByRunId("yaml-scalar"))!.observations
    const content = observations.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join("")
    expect(content).toBe(`config:\n  ${key}: [REDACTED]\n  status: ok\n`)
  })

  it.each([2, 100, 400])("rejects configuration updates when the marker cannot fit a %i-byte budget", (maxBytes) => {
    expect(() => byteBoundedObservations([
      {
        name: "vitehub.agent.configured",
        sequence: 1,
        timestamp: "2026-09-07T00:00:00.000Z",
        type: "run",
        attributes: {
          note: "x".repeat(400),
          "vitehub.agent.configuration": { instructions: "x".repeat(1_000) },
        },
      },
    ], observationLimits({ maxBytes }))).toThrow("increase observations.maxBytes to retain configuration truncation evidence")
  })

  it("retains a configuration truncation marker when earlier observations fill the byte budget", () => {
    const timestamp = "2026-09-07T00:00:00.000Z"
    const result = byteBoundedObservations([
      { name: "agent.invocation.finish", sequence: 2, timestamp, type: "run", attributes: { note: "x".repeat(170) } },
      { name: "vitehub.agent.configured", sequence: 1, timestamp, type: "run", attributes: { "vitehub.agent.configuration": { instructions: "x".repeat(1_000) } } },
    ], observationLimits({ maxBytes: 400 }))

    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(result.observations)).byteLength).toBeLessThanOrEqual(400)
    expect(result.observations).toContainEqual(expect.objectContaining({
      name: "vitehub.agent.configured",
      attributes: { "vitehub.agent.configurationTruncated": true },
    }))
  })

  it("does not mark a full journal truncated when retrying an identified observation", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const observations = Array.from({ length: 256 }, (_, index) => ({
      attributes: { "vitehub.observation.id": `journal:${index}` },
      name: "agent.channel.delivery.effect",
      sequence: index,
      timestamp: createdAt,
      type: "run" as const,
    }))
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "duplicate-at-capacity",
      observations,
      status: "completed",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: observations.at(-1),
      timestamp: createdAt,
    })

    expect(record.observations).toHaveLength(256)
    expect(record.observationsTruncated).toBeUndefined()
  })

  it("keeps distinct observations that share a locally assigned sequence", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const first = {
      attributes: { "vitehub.observation.id": "journal-a:1" },
      name: "agent.channel.delivery.effect",
      sequence: 1,
      timestamp: createdAt,
      type: "run" as const,
    }
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "concurrent-observations",
      observations: [first],
      status: "running",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        attributes: { "vitehub.observation.id": "journal-b:1" },
        name: "agent.channel.delivery.effect",
        sequence: 1,
        timestamp: createdAt,
        type: "run",
      },
      timestamp: createdAt,
    })

    expect(record.observations).toHaveLength(2)
  })

  it("retains every identified priority outcome that fits before ordinary history", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const ordinary = Array.from({ length: 254 }, (_, index) => ({
      name: `ordinary-${index}`,
      sequence: index,
      timestamp: createdAt,
      type: "run" as const,
    }))
    const streamError = {
      attributes: { "error.message": "stream failed", "vitehub.observation.id": "journal:stream-error" },
      name: "agent.stream.error",
      sequence: 254,
      timestamp: createdAt,
      type: "error" as const,
    }
    const runError = {
      attributes: { "error.message": "run failed", "vitehub.observation.id": "journal:run-error" },
      name: "run.error",
      sequence: 255,
      timestamp: createdAt,
      type: "error" as const,
    }
    const invocationError = {
      attributes: { "vitehub.observation.id": "journal:invocation-error" },
      name: "agent.invocation.error",
      sequence: 256,
      timestamp: createdAt,
      type: "error" as const,
    }
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "priority-outcomes-at-capacity",
      observations: [...ordinary, streamError, runError],
      status: "running",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: invocationError,
      timestamp: createdAt,
    })

    expect(record).toMatchObject({ observationsTruncated: true })
    expect(record.observations).toHaveLength(256)
    expect(record.observations.slice(-3).map(observation => observation.name)).toEqual([
      "agent.stream.error",
      "run.error",
      "agent.invocation.error",
    ])
    expect(record.observations.slice(-3).every(observation => observation.attributes?.["vitehub.trace.truncated"] === true)).toBe(true)
  })

  it("retains identified cancellation when the observation journal is full", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const ordinary = Array.from({ length: 256 }, (_, index) => ({
      attributes: { "vitehub.observation.id": `journal:${index}` },
      name: `ordinary-${index}`,
      sequence: index,
      timestamp: createdAt,
      type: "run" as const,
    }))
    const cancelled = {
      attributes: { "vitehub.observation.id": "journal:cancelled" },
      name: "agent.invocation.cancelled",
      sequence: 256,
      timestamp: createdAt,
      type: "run" as const,
    }

    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "cancelled-at-capacity",
      observations: ordinary,
      status: "cancelled",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: cancelled,
      timestamp: createdAt,
    })

    expect(record).toMatchObject({ observationsTruncated: true })
    expect(record.observations).toHaveLength(256)
    expect(record.observations.at(-1)).toMatchObject({
      attributes: {
        "vitehub.observation.id": "journal:cancelled",
        "vitehub.trace.truncated": true,
      },
      name: "agent.invocation.cancelled",
    })
  })

  it("reserves lifecycle evidence before recent delivery outcomes", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const lifecycle = [
      {
        attributes: { "error.message": "run failed", "vitehub.observation.id": "journal:run-error" },
        name: "run.error",
        sequence: 0,
        timestamp: createdAt,
        type: "error" as const,
      },
      {
        attributes: { "vitehub.observation.id": "journal:invocation-finish" },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: createdAt,
        type: "run" as const,
      },
    ]
    const deliveries = Array.from({ length: 254 }, (_, index) => ({
      attributes: { "vitehub.observation.id": `journal:delivery:${index}` },
      name: "agent.channel.delivery.effect",
      sequence: index + 2,
      timestamp: createdAt,
      type: "run" as const,
    }))
    const latestDelivery = {
      attributes: { "vitehub.observation.id": "journal:delivery:254" },
      name: "agent.channel.delivery.effect",
      sequence: 256,
      timestamp: createdAt,
      type: "run" as const,
    }

    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "delivery-overflow-lifecycle",
      observations: [...lifecycle, ...deliveries],
      status: "completed",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: latestDelivery,
      timestamp: createdAt,
    })

    expect(record.observations).toHaveLength(256)
    expect(record.observations.slice(0, 2).map(observation => observation.name)).toEqual([
      "run.error",
      "agent.invocation.finish",
    ])
    expect(record.observations.map(observation => observation.attributes?.["vitehub.observation.id"]))
      .not.toContain("journal:delivery:0")
    expect(record.observations.at(-1)?.attributes?.["vitehub.observation.id"]).toBe("journal:delivery:254")
    expect(record.observationsTruncated).toBe(true)
  })

  it("does not reserve lifecycle capacity for failure evidence alone", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const failures = Array.from({ length: 256 }, (_, index) => ({
      attributes: {
        "error.message": `failure ${index}`,
        "vitehub.observation.id": `journal:failure:${index}`,
      },
      name: "run.error",
      sequence: index,
      timestamp: createdAt,
      type: "error" as const,
    }))

    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "failure-evidence-at-capacity",
      observations: failures,
      status: "failed",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        attributes: { "vitehub.observation.id": "journal:late-delivery" },
        name: "agent.channel.delivery.effect",
        sequence: 256,
        timestamp: createdAt,
        type: "run",
      },
      timestamp: createdAt,
    })

    expect(record.observations).toHaveLength(256)
    expect(record.observations.map(observation => observation.attributes?.["vitehub.observation.id"]))
      .toEqual(failures.map(observation => observation.attributes["vitehub.observation.id"]))
    expect(record.observationsTruncated).toBe(true)
  })

  it("restores recovered same-priority outcomes to trace order", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "recovered-outcome-order",
      observations: [{
        attributes: { "error.message": "later fatal", "vitehub.observation.id": "journal:later" },
        name: "agent.stream.error",
        sequence: 2,
        timestamp: createdAt,
        type: "error",
      }, {
        attributes: { "vitehub.observation.id": "journal:terminal" },
        name: "agent.invocation.finish",
        sequence: 3,
        timestamp: createdAt,
        type: "run",
      }],
      status: "failed",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        attributes: { "error.message": "earliest fatal", "vitehub.observation.id": "journal:earliest" },
        name: "agent.stream.error",
        sequence: 1,
        timestamp: createdAt,
        type: "error",
      },
      timestamp: createdAt,
    })

    expect(record.observations.map(observation => observation.attributes?.["vitehub.observation.id"]))
      .toEqual(["journal:earliest", "journal:later", "journal:terminal"])
  })

  it("keeps a reconstructed full journal in trace order", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const observations = Array.from({ length: 256 }, (_, sequence) => ({
      ...(sequence === 2 ? { attributes: { "vitehub.observation.id": "journal:early-delivery" } } : {}),
      name: sequence === 2 ? "agent.channel.delivery.effect" : `ordinary-${sequence}`,
      sequence,
      timestamp: createdAt,
      type: "run" as const,
    }))
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "full-journal-order",
      observations,
      status: "running",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        attributes: { "vitehub.observation.id": "journal:late-delivery" },
        name: "agent.channel.delivery.effect",
        sequence: 256,
        timestamp: createdAt,
        type: "run",
      },
      timestamp: createdAt,
    })

    expect(record.observations.map(observation => observation.sequence))
      .toEqual(Array.from({ length: 256 }, (_, index) => index === 255 ? 256 : index))
  })

  it("selects mixed-identity outcomes in trace order", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const observations = [{
      name: "agent.channel.delivery.effect",
      sequence: 0,
      timestamp: createdAt,
      type: "run" as const,
    }, ...Array.from({ length: 255 }, (_, index) => ({
      attributes: { "vitehub.observation.id": `journal:delivery:${index + 1}` },
      name: "agent.channel.delivery.effect",
      sequence: index + 1,
      timestamp: createdAt,
      type: "run" as const,
    }))]
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "mixed-identity-order",
      observations,
      status: "running",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        attributes: { "vitehub.observation.id": "journal:delivery:256" },
        name: "agent.channel.delivery.effect",
        sequence: 256,
        timestamp: createdAt,
        type: "run",
      },
      timestamp: createdAt,
    })

    expect(record.observations.map(observation => observation.sequence)).toEqual(Array.from({ length: 256 }, (_, index) => index + 1))
  })

  it("keeps synchronous delivery before a later finish observation below capacity", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "delivery-before-finish",
      observations: [{
        attributes: { "vitehub.observation.id": "journal:delivery" },
        name: "agent.channel.delivery.effect",
        sequence: 1,
        timestamp: createdAt,
        type: "run",
      }],
      status: "running",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        attributes: { "vitehub.observation.id": "journal:finish" },
        name: "agent.invocation.finish",
        sequence: 2,
        timestamp: createdAt,
        type: "run",
      },
      timestamp: createdAt,
    })

    expect(record.observations.map(observation => observation.attributes?.["vitehub.observation.id"]))
      .toEqual(["journal:delivery", "journal:finish"])
  })

  it("keeps unidentified observations that share a locally assigned sequence", () => {
    const createdAt = "2026-02-02T02:02:02.000Z"
    const record = applyAgentInvocationStoreUpdate({
      createdAt,
      cursor: "1",
      id: "concurrent-unidentified-observations",
      observations: [{
        name: "first",
        sequence: 1,
        timestamp: createdAt,
        type: "run",
      }],
      status: "running",
      traceId: "trace",
      updatedAt: createdAt,
    }, {
      observation: {
        name: "second",
        sequence: 1,
        timestamp: createdAt,
        type: "run",
      },
      timestamp: createdAt,
    })

    expect(record.observations.map(observation => observation.name)).toEqual(["first", "second"])
  })

  it("preserves observation identities through attribute bounds in memory and SQLite stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-observation-identity-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const stores = [createMemoryAgentInvocationStore(), createLibsqlAgentInvocationStore({ client })]
    const createdAt = "2026-02-02T02:02:02.000Z"
    try {
      for (const [index, store] of stores.entries()) {
        const id = `bounded-identity-${index}`
        const observation = {
          attributes: {
            ...Object.fromEntries(Array.from({ length: 32 }, (_, attribute) => [`attribute-${attribute}`, attribute])),
            "vitehub.observation.id": "journal:1",
          },
          name: "agent.channel.delivery.effect",
          sequence: 1,
          timestamp: createdAt,
          type: "run" as const,
        }
        await store.create({
          createdAt,
          id,
          observations: [],
          status: "running",
          traceId: id,
          updatedAt: createdAt,
        })
        await store.update(id, { observation, timestamp: createdAt })
        await store.update(id, { observation, timestamp: createdAt })

        const record = await store.get(id)
        expect(record?.observations).toHaveLength(1)
        expect(record?.observations[0]?.attributes).toMatchObject({ "vitehub.observation.id": "journal:1" })
      }
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects reserved trace attributes in metadataContent", () => {
    expect(() => defineAgentInvocations({
      metadataContent: ["vitehub.payload.value"],
      store: createMemoryAgentInvocationStore(),
    })).toThrow("metadataContent cannot include reserved trace attributes")
  })

  it("excludes generated cursors from memory-store search", async () => {
    const store = createMemoryAgentInvocationStore()
    await store.create({
      createdAt: "2026-02-02T02:02:02.000Z",
      id: "alpha",
      observations: [],
      status: "pending",
      traceId: "alpha-trace",
      updatedAt: "2026-02-02T02:02:02.000Z",
    })

    expect(store.list({ search: "1" })).toEqual({ invocations: [] })
  })

  it("filters memory-store records by exact Agent name", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const agentName of ["review", "review-assistant"]) {
      await store.create({
        agentName,
        createdAt: "2026-02-02T02:02:02.000Z",
        id: agentName,
        observations: [],
        status: "completed",
        traceId: `${agentName}-trace`,
        updatedAt: "2026-02-02T02:02:02.000Z",
      })
    }

    expect(store.list({ agentName: "review" })).toMatchObject({
      invocations: [{ agentName: "review" }],
    })
  })

  it.each([" ", "\t", "\n", "\u00a0", "\u000b\u000c\r\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"])("filters invocation stores by the exact capability that was used with whitespace %j", async (whitespace) => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-capability-filter-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const stores = [createMemoryAgentInvocationStore(), createLibsqlAgentInvocationStore({ client })]
    const timestamp = new Date().toISOString()
    try {
      for (const [storeIndex, store] of stores.entries()) {
        for (const [recordIndex, capabilityId] of ["papercuts", "usage", undefined].entries()) {
          await store.create({
            agentName: "chat",
            annotations: recordIndex < 2 ? { triggeredBy: recordIndex === 0 ? `${whitespace}Ferdinand${whitespace}` : "Maxi" } : undefined,
            createdAt: timestamp,
            id: `${storeIndex}-${recordIndex}`,
            observations: capabilityId
              ? [{
                  attributes: { "capability.id": capabilityId },
                  name: "agent.tool.finish",
                  sequence: 1,
                  timestamp,
                  type: "run",
                }]
              : [],
            status: "completed",
            traceId: `${storeIndex}-${recordIndex}-trace`,
            updatedAt: timestamp,
          })
        }

        await expect(Promise.resolve(store.list({ capabilityId: "papercuts" }))).resolves.toMatchObject({
          invocations: [{ id: `${storeIndex}-0` }],
        })
        await expect(defineAgentInvocations({ store }).listCapabilityIds("chat"))
          .resolves.toEqual(["papercuts", "usage"])
        await expect(Promise.resolve(store.list({ agentName: "chat", capabilityId: "papercuts", triggeredBy: "Ferdinand" }))).resolves.toMatchObject({
          invocations: [{ id: `${storeIndex}-0` }],
        })
        await expect(Promise.resolve(store.list({ triggeredBy: "ferdinand" }))).resolves.toEqual({ invocations: [] })
        await expect(defineAgentInvocations({ store }).listTriggeredBy("chat"))
          .resolves.toEqual(["Ferdinand", "Maxi"])
      }
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it.each([123, true, false, null])("ignores non-string triggering-person annotations %j across stores", async (triggeredBy) => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-person-filter-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const stores = [createMemoryAgentInvocationStore(), createLibsqlAgentInvocationStore({ client })]
    const timestamp = new Date().toISOString()
    const filter = triggeredBy === true ? "1" : triggeredBy === false ? "0" : String(triggeredBy)
    try {
      for (const store of stores) {
        for (const [id, value] of [["scalar", triggeredBy], ["text", filter]] as const) {
          await store.create({
            annotations: { triggeredBy: value },
            createdAt: timestamp,
            id,
            observations: [],
            status: "completed",
            traceId: id,
            updatedAt: timestamp,
          })
        }
        expect((await store.list({ triggeredBy: filter })).invocations.map(item => item.id)).toEqual(["text"])
      }
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("keeps Capability use queryable after the observation journal is truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-truncated-capability-filter-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const stores = [createMemoryAgentInvocationStore(), createLibsqlAgentInvocationStore({ client })]
    try {
      for (const [index, store] of stores.entries()) {
        const runId = `truncated-capability-${index}`
        const invocations = defineAgentInvocations({ store })
        const journal = await bindAgentInvocations(invocations, runtime(runId))
        if (!journal) throw new Error("Expected the invocation journal to be configured.")
        await journal.running()
        for (let observation = 0; observation < 256; observation++) {
          await journal.context.traceLog?.append({ name: `ordinary-${observation}`, type: "run" })
        }
        await journal.context.traceLog?.append({
          attributes: { "capability.id": "late-capability" },
          name: "agent.tool.start",
          type: "run",
        })

        await vi.waitFor(async () => {
          await expect(invocations.list({ capabilityId: "late-capability" })).resolves.toMatchObject({
            invocations: [{ capabilityIds: ["late-capability"], id: expect.any(String) }],
          })
          await expect(invocations.listCapabilityIds()).resolves.toEqual(["late-capability"])
        })
        const record = await invocations.getByRunId(runId)
        expect(record).toMatchObject({ observationsTruncated: true })
        expect(record?.observations).toHaveLength(256)
        expect(record?.observations.some(observation => observation.attributes?.["capability.id"] === "late-capability"))
          .toBe(false)
        await journal.finish("completed")
      }
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it.each(["completed", "failed", "cancelled"] as const)(
    "persists post-capacity Capability use through the %s terminal fallback",
    async (status) => {
      vi.useFakeTimers()
      let releaseCapabilityWrite: (() => void) | undefined
      let releaseTerminalObservationWrite: (() => void) | undefined
      let rejectTerminalOutcome = true
      try {
        const memory = createMemoryAgentInvocationStore()
        const capabilityWriteReleased = new Promise<void>((resolve) => { releaseCapabilityWrite = resolve })
        const terminalObservationWriteReleased = new Promise<void>((resolve) => {
          releaseTerminalObservationWrite = resolve
        })
        let reportCapabilityWriteStarted!: () => void
        const capabilityWriteStarted = new Promise<void>((resolve) => { reportCapabilityWriteStarted = resolve })
        let reportTerminalObservationWriteStarted!: () => void
        const terminalObservationWriteStarted = new Promise<void>((resolve) => {
          reportTerminalObservationWriteStarted = resolve
        })
        const invocations = defineAgentInvocations({
          store: {
            ...memory,
            async update(id, input, claimId) {
              if (input.status === undefined && input.capabilityIds?.includes("late-capability")) {
                reportCapabilityWriteStarted()
                await capabilityWriteReleased
              }
              if (input.status === undefined && input.observation?.name === "agent.invocation.finish") {
                reportTerminalObservationWriteStarted()
                await terminalObservationWriteReleased
              }
              if (rejectTerminalOutcome && input.status === status && input.observation) {
                rejectTerminalOutcome = false
                return
              }
              return memory.update(id, input, claimId)
            },
          },
        })
        const runId = `stalled-capability-${status}`
        const journal = await bindAgentInvocations(invocations, runtime(runId))
        if (!journal) throw new Error("Expected the invocation journal to be configured.")
        await journal.running()
        for (let observation = 0; observation < 256; observation++) {
          await journal.context.traceLog?.append({ name: `ordinary-${observation}`, type: "run" })
        }
        await vi.waitFor(async () => {
          expect((await invocations.getByRunId(runId))?.observations).toHaveLength(256)
        })
        await journal.context.traceLog?.append({
          attributes: { "capability.id": "late-capability" },
          name: "agent.tool.start",
          type: "run",
        })
        await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })
        await Promise.all([capabilityWriteStarted, terminalObservationWriteStarted])

        const finishing = journal.finish(status, status === "failed" ? new Error("provider failed") : undefined)
        await vi.advanceTimersByTimeAsync(1_000)
        await finishing
        expect(rejectTerminalOutcome).toBe(false)
        releaseCapabilityWrite?.()
        releaseTerminalObservationWrite?.()
        await vi.advanceTimersByTimeAsync(0)

        await expect(invocations.getByRunId(runId)).resolves.toMatchObject({
          capabilityIds: ["late-capability"],
          observationsTruncated: true,
          status,
        })
        await expect(invocations.list({ capabilityId: "late-capability" })).resolves.toMatchObject({
          invocations: [{ id: expect.any(String), status }],
        })
      }
      finally {
        releaseCapabilityWrite?.()
        releaseTerminalObservationWrite?.()
        vi.useRealTimers()
      }
    },
  )

  it("lists distinct Agent names without paging through invocation summaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-names-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const stores = [createMemoryAgentInvocationStore(), createLibsqlAgentInvocationStore({ client })]
    const timestamp = new Date().toISOString()
    try {
      for (const [index, store] of stores.entries()) {
        for (const [record, agentName] of ["review", "support", "review", "legacy"].entries()) {
          await store.create({
            agentName,
            createdAt: timestamp,
            id: `${index}-${record}`,
            observations: [],
            status: "completed",
            traceId: `${index}-${record}-trace`,
            updatedAt: timestamp,
          })
        }
        if (index === 1) {
          await client.execute({
            args: [`${index}-3`],
            sql: "UPDATE vitehub_agent_invocations SET agent_name = '' WHERE id = ?",
          })
        }

        await expect(defineAgentInvocations({ store }).listAgentNames()).resolves.toEqual([
          "legacy",
          "review",
          "support",
        ])
      }
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("lists Agent names through every page for stores without an optimized index", async () => {
    const memory = createMemoryAgentInvocationStore()
    const timestamp = new Date().toISOString()
    for (let index = 0; index < 101; index++) {
      const agentName = index % 3 === 0 ? " beta " : index % 3 === 1 ? "alpha" : undefined
      await memory.create({
        ...(agentName ? { agentName } : {}),
        createdAt: timestamp,
        id: `fallback-${index}`,
        observations: [],
        status: "completed",
        traceId: `fallback-${index}-trace`,
        updatedAt: timestamp,
      })
    }
    const { listAgentNames: _listAgentNames, ...fallback } = memory
    const list = vi.fn(fallback.list)

    await expect(defineAgentInvocations({ store: { ...fallback, list } }).listAgentNames())
      .resolves.toEqual(["alpha", "beta"])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it("lists triggering people from summaries across every fallback page", async () => {
    const memory = createMemoryAgentInvocationStore()
    const timestamp = new Date().toISOString()
    for (let index = 0; index < 101; index++) {
      await memory.create({
        annotations: index === 100 ? { triggeredBy: " Ferdinand " } : index === 0 ? { triggeredBy: "Maxi" } : undefined,
        createdAt: timestamp,
        id: `triggered-by-fallback-${index}`,
        observations: [],
        status: "completed",
        traceId: `triggered-by-fallback-${index}-trace`,
        updatedAt: timestamp,
      })
    }
    const { listTriggeredBy: _listTriggeredBy, ...fallback } = memory
    const list = vi.fn(fallback.list)
    const get = vi.fn(() => { throw new Error("observation body read") })

    await expect(defineAgentInvocations({ store: { ...fallback, get, list } }).listTriggeredBy())
      .resolves.toEqual(["Ferdinand", "Maxi"])
    expect(list).toHaveBeenCalledTimes(2)
    expect(get).not.toHaveBeenCalled()
  })

  it("does not let a stalled store block Agent execution", async () => {
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        create: () => new Promise(() => {}),
      },
    })
    const run = vi.fn(() => "done")

    const invocation = runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("stalled-store"), {})

    await expect(invocation).resolves.toBe("done")
    expect(run).toHaveBeenCalledOnce()
    await expect(invocations.getByRunId("stalled-store")).resolves.toBeUndefined()
  }, 10_000)

  it("does not block trace appends on stalled observation writes", async () => {
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        update: (id, input, claimId) => input.observation
          ? new Promise(() => {})
          : memory.update(id, input, claimId),
      },
    })
    let appendDuration = Number.POSITIVE_INFINITY
    const agent = defineAgent({
      driver: { async run(context) {
        const startedAt = Date.now()
        await context.traceLog?.append({ name: "custom", type: "run" })
        appendDuration = Date.now() - startedAt
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime("stalled-observation"), {})).resolves.toBe("done")
    expect(appendDuration).toBeLessThan(500)
    await expect(invocations.getByRunId("stalled-observation")).resolves.toMatchObject({ status: "completed" })
  }, 5_000)

  it("persists delivery observations emitted after terminal finalization", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("late-delivery-observation"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.finish("completed")

    await journal.context.traceLog?.append({
      attributes: { "channel.effect.content": "Streamed reply" },
      name: "agent.channel.delivery.effect",
      type: "run",
    })

    await vi.waitFor(async () => {
      const record = await invocations.getByRunId("late-delivery-observation")
      expect(record).toMatchObject({ status: "completed" })
      expect(record?.observations).toEqual([
        expect.objectContaining({
          attributes: expect.objectContaining({ "channel.effect.content": "Streamed reply" }),
          name: "agent.channel.delivery.effect",
        }),
      ])
    })
  })

  it("retries late delivery observations after a transient store failure", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let observationAttempts = 0
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          update(id, input, claimId) {
            if (input.observation && observationAttempts++ === 0) return undefined
            return memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("retry-late-delivery"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.finish("completed")

      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Late reply" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })
      await vi.advanceTimersByTimeAsync(1_000)

      const record = await invocations.getByRunId("retry-late-delivery")
      expect(observationAttempts).toBe(2)
      expect(record?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "channel.effect.content": "Late reply" }),
        name: "agent.channel.delivery.effect",
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not duplicate a late delivery when the store commits before timing out", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          async update(id, input, claimId) {
            const updated = await memory.update(id, input, claimId)
            if (input.observation) await new Promise(resolve => setTimeout(resolve, 1_500))
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("slow-late-delivery"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.finish("completed")

      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Late reply" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })
      await vi.advanceTimersByTimeAsync(1_500)

      const record = await invocations.getByRunId("slow-late-delivery")
      expect(record?.observations.filter(observation =>
        observation.name === "agent.channel.delivery.effect"
        && observation.attributes?.["channel.effect.content"] === "Late reply",
      )).toHaveLength(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("persists delivery observations emitted while terminal finalization retries", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let terminalAttempts = 0
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          update(id, input, claimId) {
            if (input.status === "completed" && terminalAttempts++ === 0) return undefined
            return memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("retrying-terminal-delivery"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.finish("completed")

      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Reply delivered during retry" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })
      await vi.advanceTimersByTimeAsync(1_000)

      await vi.waitFor(async () => {
        const record = await invocations.getByRunId("retrying-terminal-delivery")
        expect(record).toMatchObject({ status: "completed" })
        expect(record?.observations).toContainEqual(expect.objectContaining({
          attributes: expect.objectContaining({ "channel.effect.content": "Reply delivered during retry" }),
          name: "agent.channel.delivery.effect",
        }))
        expect(Date.parse(record!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(record!.completedAt!))
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("keeps retry-exhaustion delivery persistence under runtime custody", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseObservation!: () => void
      const observationBlocked = new Promise<void>(resolve => releaseObservation = resolve)
      const waitUntilTasks: Array<Promise<unknown>> = []
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.status === "completed") return undefined
            if (input.observation) await observationBlocked
            return memory.update(id, input, claimId)
          },
        },
      })
      const context = {
        ...runtime("exhausted-terminal-delivery"),
        waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task) },
      }
      const journal = await bindAgentInvocations(invocations, context)
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.finish("completed")
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Reply during exhausted retry" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })

      await vi.advanceTimersByTimeAsync(60_000)
      expect(waitUntilTasks).toHaveLength(1)
      let recoverySettled = false
      void waitUntilTasks[0]!.then(() => recoverySettled = true)
      await Promise.resolve()
      expect(recoverySettled).toBe(false)

      releaseObservation()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.all(waitUntilTasks)
      const record = await invocations.getByRunId("exhausted-terminal-delivery")
      expect(record?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "channel.effect.content": "Reply during exhausted retry" }),
        name: "agent.channel.delivery.effect",
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("recovers a delivery after its ordinary write and retry both fail", async () => {
    const memory = createMemoryAgentInvocationStore()
    const waitUntilTasks: Array<Promise<unknown>> = []
    let deliveryAttempts = 0
    const invocations = defineAgentInvocations({
      content: "content",
      store: {
        ...memory,
        update(id, input, claimId) {
          if (input.observation?.name === "agent.channel.delivery.effect" && deliveryAttempts++ < 2) return undefined
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, {
      ...runtime("twice-failed-delivery"),
      waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task) },
    })
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({
      attributes: { "channel.effect.content": "Reply recovered after retry" },
      name: "agent.channel.delivery.effect",
      type: "run",
    })
    await vi.waitFor(() => expect(deliveryAttempts).toBe(2))

    await journal.finish("completed")
    await Promise.all(waitUntilTasks)

    const record = await invocations.getByRunId("twice-failed-delivery")
    expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
    expect(record?.observations).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({ "channel.effect.content": "Reply recovered after retry" }),
      name: "agent.channel.delivery.effect",
    }))
  })

  it("recovers a delivery after its ordinary write and retry both time out", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const waitUntilTasks: Array<Promise<unknown>> = []
      let deliveryAttempts = 0
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          update(id, input, claimId) {
            if (input.observation?.name === "agent.channel.delivery.effect" && deliveryAttempts++ < 2) {
              return new Promise(() => {})
            }
            return memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, {
        ...runtime("twice-timed-out-delivery"),
        waitUntil: (task: Promise<unknown>) => { waitUntilTasks.push(task) },
      })
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Reply recovered after timeouts" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(deliveryAttempts).toBe(2)

      await journal.finish("completed")
      await vi.runAllTimersAsync()
      await Promise.all(waitUntilTasks)

      const record = await invocations.getByRunId("twice-timed-out-delivery")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "channel.effect.content": "Reply recovered after timeouts" }),
        name: "agent.channel.delivery.effect",
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("retains late delivery outcomes when a completed journal is at capacity", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("late-delivery-at-capacity"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    for (let index = 0; index < 255; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }
    await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })
    await journal.finish("completed")

    for (const content of ["First streamed reply", "Second streamed reply"]) {
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": content },
        name: "agent.channel.delivery.effect",
        type: "run",
      })
    }

    await vi.waitFor(async () => {
      const record = await invocations.getByRunId("late-delivery-at-capacity")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations).toHaveLength(256)
      expect(record?.observations.slice(-3)).toMatchObject([
        { name: "agent.invocation.finish" },
        {
          attributes: { "channel.effect.content": "First streamed reply" },
          name: "agent.channel.delivery.effect",
        },
        {
          attributes: { "channel.effect.content": "Second streamed reply" },
          name: "agent.channel.delivery.effect",
        },
      ])
    })
  })

  it("retains delivery outcomes when a running journal is at capacity", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("running-delivery-at-capacity"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    for (let index = 0; index < 256; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }
    await journal.context.traceLog?.append({
      attributes: { "channel.effect.content": "Reply before finalization" },
      name: "agent.channel.delivery.effect",
      type: "run",
    })

    await vi.waitFor(async () => {
      const record = await invocations.getByRunId("running-delivery-at-capacity")
      expect(record).toMatchObject({ observationsTruncated: true, status: "running" })
      expect(record?.observations).toHaveLength(256)
      expect(record?.observations.at(-1)).toMatchObject({
        attributes: { "channel.effect.content": "Reply before finalization" },
        name: "agent.channel.delivery.effect",
      })
    })
  })

  it("persists truncation when a running invocation reaches observation capacity", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("running-observation-capacity"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    for (let index = 0; index < 257; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }

    await vi.waitFor(async () => {
      const record = await invocations.getByRunId("running-observation-capacity")
      expect(record).toMatchObject({ observationsTruncated: true, status: "running" })
      expect(record?.observations).toHaveLength(256)
    })
  })

  it("persists truncation after a synchronous observation-store failure", async () => {
    const memory = createMemoryAgentInvocationStore()
    let rejectObservation = true
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        update(id, input, claimId) {
          if (rejectObservation && input.observation) {
            rejectObservation = false
            throw new Error("synchronous observation failure")
          }
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, runtime("synchronous-observation-failure"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({ name: "ordinary", type: "run" })

    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("synchronous-observation-failure"))
        .resolves.toMatchObject({ observationsTruncated: true, status: "running" })
    })
  })

  it("does not let malformed custom trace entries fail Agent execution", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const traceLog = {
      append: vi.fn(async (event: Record<string, unknown>) => ({ ...event, timestamp: new Date(Number.NaN) })),
      entries: () => [],
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "malformed", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    // SAFETY: This fixture supplies the custom Trace Event Log shape accepted by the runtime boundary.
    await expect(runAgent(agent, { ...runtime("malformed-trace"), traceLog } as never, {})).resolves.toBe("done")
    await expect(invocations.getByRunId("malformed-trace")).resolves.toMatchObject({ status: "completed" })
  })

  it("handles journal normalization rejection while the wrapped trace log is pending", async () => {
    let releaseAppend!: () => void
    const appendPending = new Promise<void>(resolve => { releaseAppend = resolve })
    const traceLog = {
      append: vi.fn(async (event: Record<string, unknown>) => {
        await appendPending
        return { ...event, timestamp: new Date().toISOString() }
      }),
      entries: () => [],
    }
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    // SAFETY: This fixture supplies a valid custom Trace Event Log with a deliberately pending append.
    const journal = await bindAgentInvocations(invocations, { ...runtime("pending-malformed-trace"), traceLog } as never)
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)

    try {
      // SAFETY: This malformed event deliberately bypasses the Trace Event timestamp contract.
      const appended = journal.context.traceLog?.append({
        name: "malformed",
        timestamp: new Date(Number.NaN),
        type: "run",
      } as never)
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
      releaseAppend()
      await expect(appended).resolves.toMatchObject({ name: "malformed" })
    }
    finally {
      releaseAppend()
      process.off("unhandledRejection", unhandled)
    }
  })

  it("isolates invocation persistence from a rejecting caller trace log", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const traceLog = {
      append: vi.fn(async () => { throw new Error("trace sink unavailable") }),
      entries: () => [],
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "resolved.configuration", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    // SAFETY: This fixture supplies the runtime trace-log contract and intentionally makes append reject.
    await expect(runAgent(agent, { ...runtime("rejecting-trace"), traceLog } as never, {})).resolves.toBe("done")
    const persisted = await invocations.getByRunId("rejecting-trace")
    expect(persisted).toMatchObject({ status: "completed" })
    expect(persisted?.observations.map(entry => entry.name)).toEqual(expect.arrayContaining([
      "vitehub.agent.configured",
      "resolved.configuration",
      "agent.invocation.finish",
    ]))
  })

  it("guards metadata content inspection for custom trace attributes", async () => {
    const invocations = defineAgentInvocations({
      metadataContent: ["message.content"],
      store: createMemoryAgentInvocationStore(),
    })
    const traceLog = createTraceEventLog({ content: "content" })
    const append = vi.spyOn(traceLog, "append")
    const journal = await bindAgentInvocations(invocations, { ...runtime("hostile-metadata-content"), traceLog })
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    const attributes = new Proxy({ "message.content": "persisted" }, {
      has() {
        throw new Error("membership unavailable")
      },
    })

    await expect(journal.context.traceLog?.append({ attributes, name: "custom", type: "run" })).resolves.toBeDefined()
    await journal.finish("completed")

    expect(append).toHaveBeenCalledWith(expect.objectContaining({ name: "custom" }))
    const observation = (await invocations.getByRunId("hostile-metadata-content"))?.observations
      .find(entry => entry.name === "custom")
    expect(observation?.attributes?.["message.content"]).toBe("persisted")
  })

  it("keeps omission markers when selected metadata content cannot be captured", async () => {
    const invocations = defineAgentInvocations({
      metadataContent: ["message.content"],
      store: createMemoryAgentInvocationStore(),
    })
    const journal = await bindAgentInvocations(invocations, runtime("uncaptured-metadata-content"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    const accessorAttributes: Record<string, unknown> = {}
    Object.defineProperty(accessorAttributes, "message.content", {
      enumerable: true,
      get: () => "accessor content",
    })

    await journal.context.traceLog?.append({ attributes: accessorAttributes, name: "accessor", type: "run" })
    await journal.context.traceLog?.append({
      attributes: { "message.content": () => "uncloneable content" },
      name: "uncloneable",
      type: "run",
    })
    await journal.context.traceLog?.append({
      attributes: { "message.content": undefined },
      name: "undefined",
      type: "run",
    })
    await journal.finish("completed")

    const observations = (await invocations.getByRunId("uncaptured-metadata-content"))?.observations
    for (const name of ["accessor", "uncloneable", "undefined"]) {
      const observation = observations?.find(entry => entry.name === name)
      expect(observation?.attributes?.["content.omitted"]).toEqual(["message.content"])
      expect(observation?.attributes).not.toHaveProperty("message.content")
    }
  })

  it("retains a full multi-capability tool catalog within the configuration budget", async () => {
    const invocations = defineAgentInvocations({ configuration: "content", observations: { maxStringLength: 1024 * 1024 }, store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("large-tool-catalog"))
    if (!journal) throw new Error("Expected the invocation journal.")
    const nestedSchema = Array.from({ length: 20 }).reduce<Record<string, unknown>>(
      child => ({ type: "object", properties: { child } }), { type: "string" },
    )
    const tools = Array.from({ length: 40 }, (_, index) => ({
      name: `tool_${index}`, capabilityId: `capability_${index % 8}`, description: "Read the current workspace file. ".repeat(80),
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Relative path", enum: Array.from({ length: 600 }, (_, index) => `path_${index}`) } }, required: ["path"] },
      outputSchema: { type: "object", properties: { content: nestedSchema } },
    }))
    await journal.context.traceLog?.append({ name: "vitehub.agent.configured", type: "run", attributes: {
      "vitehub.agent.configuration": { tools },
    } })
    await journal.finish("completed")
    const event = (await invocations.getByRunId("large-tool-catalog"))?.observations.find(entry => entry.name === "vitehub.agent.configured")
    expect(event?.attributes?.["vitehub.agent.configuration"]).toEqual({ tools })
    expect(event?.attributes).not.toHaveProperty("vitehub.agent.configurationTruncated")
  })

  it("retains individual configuration strings above the default limit when explicitly allowed", async () => {
    const instructions = ["x".repeat(100 * 1024)]
    const invocations = defineAgentInvocations({ configuration: "content", observations: { maxStringLength: 1024 * 1024 }, store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("long-configuration-string"))
    if (!journal) throw new Error("Expected the invocation journal.")
    await journal.context.traceLog?.append({ name: "vitehub.agent.configured", type: "run", attributes: {
      "vitehub.agent.configuration": { instructions },
    } })
    await journal.finish("completed")
    const event = (await invocations.getByRunId("long-configuration-string"))?.observations.find(entry => entry.name === "vitehub.agent.configured")
    expect(event?.attributes?.["vitehub.agent.configuration"]).toEqual({ instructions })
    expect(event?.attributes).not.toHaveProperty("vitehub.agent.configurationTruncated")
  })

  it("constrains retained configuration to an explicit string budget", async () => {
    const invocations = defineAgentInvocations({ configuration: "content", observations: { maxStringLength: 4096 }, store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("limited-configuration"))
    if (!journal) throw new Error("Expected the invocation journal.")
    await journal.context.traceLog?.append({ name: "vitehub.agent.configured", type: "run", attributes: {
      "vitehub.agent.configuration": { instructions: ["x".repeat(5000), "y".repeat(5000)] },
    } })
    await journal.finish("completed")
    const event = (await invocations.getByRunId("limited-configuration"))?.observations.find(entry => entry.name === "vitehub.agent.configured")
    expect(event?.attributes?.["vitehub.agent.configuration"]).toEqual({ instructions: ["x".repeat(4096), "[truncated]"] })
    expect(event?.attributes?.["vitehub.agent.configurationTruncated"]).toBe(true)
  })

  it("marks bounded Agent configuration as truncated", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-configuration"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      attributes: { "vitehub.agent.configuration": { instructions: ["x".repeat(100_000)] } },
      name: "vitehub.agent.configured",
      type: "run",
    })
    await journal.finish("completed")

    const configured = (await invocations.getByRunId("bounded-configuration"))?.observations
      .find(entry => entry.name === "vitehub.agent.configured")
    expect(configured?.attributes?.["vitehub.agent.configurationTruncated"]).toBe(true)
  })

  it("retains realistic Agent tool configuration without marking setup as truncated", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("tool-configuration"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    const tools = Array.from({ length: 40 }, (_, index) => ({
      description: `Inspect support resource ${index}`,
      name: `support_resource_${index}`,
      parameters: {
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object",
      },
    }))
    await journal.context.traceLog?.append({
      attributes: { "vitehub.agent.configuration": { capabilities: [{ id: "support", tools }] } },
      name: "vitehub.agent.configured",
      type: "run",
    })
    await journal.finish("completed")

    const configured = (await invocations.getByRunId("tool-configuration"))?.observations
      .find(entry => entry.name === "vitehub.agent.configured")
    expect(configured?.attributes).not.toHaveProperty("vitehub.agent.configurationTruncated")
    expect(configured?.attributes?.["vitehub.agent.configuration"]).toMatchObject({
      capabilities: [{ tools }],
    })
  })

  it("preserves sanitized Agent configuration depth and indexes its resolved model", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const saturatedAnnotations = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`custom.${index}`, index]),
    )
    const journal = await bindAgentInvocations(
      invocations,
      runtime("nested-configuration", saturatedAnnotations),
    )
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      attributes: {
        "vitehub.agent.configuration": {
          capabilities: [{ id: "otlp", metadata: { signals: ["traces"] } }],
          driver: { kind: "provider", model: { id: "gpt-5.6-sol", provider: "codex" } },
          runtime: { name: "ViteHub" },
        },
      },
      name: "vitehub.agent.configured",
      type: "run",
    })
    await journal.finish("completed")

    const record = await invocations.getByRunId("nested-configuration")
    const configured = record?.observations.findLast(entry => entry.name === "vitehub.agent.configured")
    expect(configured?.attributes).not.toHaveProperty("vitehub.agent.configurationTruncated")
    expect(configured?.attributes?.["vitehub.agent.configuration"]).toMatchObject({
      capabilities: [{ id: "otlp", metadata: { signals: ["traces"] } }],
    })
    expect(record?.annotations).toMatchObject({
      "agent.model.id": "gpt-5.6-sol",
      "agent.model.provider": "codex",
    })
    expect(Object.keys(record?.annotations || {})).toHaveLength(32)
    await expect(invocations.list()).resolves.toMatchObject({
      invocations: [{ annotations: {
        "agent.model.id": "gpt-5.6-sol",
        "agent.model.provider": "codex",
      } }],
    })
  })

  it("marks bounded ordinary observations as truncated", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-ordinary-observation"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      attributes: { metadata: "x".repeat(10_000) },
      name: "tool.finish",
      type: "run",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-ordinary-observation"))?.observations
      .find(entry => entry.name === "tool.finish")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
  })

  it("omits nested optional metadata without reporting content truncation", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("optional-observation-metadata"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      attributes: {
        "usage.record": {
          usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: 42 },
        },
      },
      name: "agent.invocation.finish",
      type: "run",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("optional-observation-metadata"))?.observations
      .find(entry => entry.name === "agent.invocation.finish")
    expect(observation?.attributes?.["usage.record"]).toEqual({ usage: { totalTokens: 42 } })
    expect(observation?.attributes).not.toHaveProperty("vitehub.observation.truncated")
  })

  it("reserves the observation attribute limit for the truncation marker", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-attribute-count"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    const attributes = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]))
    await journal.context.traceLog?.append({ attributes, name: "tool.finish", type: "run" })
    const exactLimitAttributes = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`exact-${index}`, index]))
    await journal.context.traceLog?.append({ attributes: exactLimitAttributes, name: "tool.exact-limit", type: "run" })
    await journal.finish("completed")

    const observations = (await invocations.getByRunId("bounded-attribute-count"))?.observations
    const observation = observations?.find(entry => entry.name === "tool.finish")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(Object.keys(observation?.attributes || {})).toHaveLength(32)
    const exactLimitObservation = observations?.find(entry => entry.name === "tool.exact-limit")
    expect(exactLimitObservation?.attributes).toEqual(exactLimitAttributes)
  })

  it("bounds public trace payloads before persisting invocation observations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: { value: { files: "x".repeat(100_000) }, visibility: "public" },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(JSON.stringify(observation?.payload).length).toBeLessThan(100_000)
  })

  it("serializes structured public payload values before persisting invocation observations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("structured-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          createdAt: new Date("2026-08-27T00:00:00.000Z"),
          data: new Uint8Array([1, 2, 3]),
          files: new Map([["README.md", 42]]),
          invalidDate: new Date(Number.NaN),
          paths: new Set(["README.md", "package.json"]),
          pattern: /vitehub/gi,
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("structured-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(observation?.payload).toEqual({
      value: {
        createdAt: { type: "Date", value: "2026-08-27T00:00:00.000Z" },
        data: { bytes: [1, 2, 3], type: "Uint8Array" },
        files: [["README.md", 42]],
        invalidDate: { type: "Date", value: "Invalid Date" },
        paths: ["README.md", "package.json"],
        pattern: { flags: "gi", lastIndex: 0, source: "vitehub" },
      },
      visibility: "public",
    })
  })

  it("retains RegExp state and Error details when bounding invocation observations", async () => {
    const store = createMemoryAgentInvocationStore()
    await store.create({
      createdAt: "2026-08-27T00:00:00.000Z",
      id: "built-in-details",
      observations: [],
      status: "running",
      traceId: "built-in-details-trace",
      updatedAt: "2026-08-27T00:00:00.000Z",
    })
    const pattern = /vitehub/gi
    pattern.lastIndex = 3
    const error = new AggregateError([new Error("first")], "outer", { cause: { code: "inner" } })
    Object.assign(error, { code: "E_OUTER" })

    await store.update("built-in-details", {
      observation: {
        name: "workspace.materialized",
        payload: { value: { error, pattern }, visibility: "public" },
        sequence: 1,
        timestamp: "2026-08-27T00:00:00.000Z",
        type: "lifecycle",
      },
      timestamp: "2026-08-27T00:00:00.000Z",
    })

    expect((await store.get("built-in-details"))?.observations[0]?.payload).toEqual({
      value: {
        error: {
          cause: { code: "inner" },
          code: "E_OUTER",
          errors: [{ message: "first", name: "Error" }],
          message: "outer",
          name: "AggregateError",
        },
        pattern: { flags: "gi", lastIndex: 3, source: "vitehub" },
      },
      visibility: "public",
    })
  })

  it("serializes public Blob, File, and boxed primitive payload values before persistence", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("remaining-structured-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          blob: new Blob([new Uint8Array([1, 2])], { type: "application/octet-stream" }),
          boxedBigInt: Object(9n),
          boxedBoolean: new Boolean(false),
          boxedNumber: new Number(5),
          boxedString: new String("one"),
          file: new File([new Uint8Array([3, 4])], "report.txt", { lastModified: 1_768_435_200_000, type: "text/plain" }),
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("remaining-structured-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(observation?.payload).toEqual({
      value: {
        blob: { bytes: [1, 2], mediaType: "application/octet-stream", size: 2, type: "Blob" },
        boxedBigInt: { type: "BigInt", value: "9" },
        boxedBoolean: { type: "Boolean", value: false },
        boxedNumber: { type: "Number", value: 5 },
        boxedString: { type: "String", value: "one" },
        file: {
          bytes: [3, 4],
          lastModified: 1_768_435_200_000,
          mediaType: "text/plain",
          name: "report.txt",
          size: 2,
          type: "File",
        },
      },
      visibility: "public",
    })
    expect(observation?.attributes?.["vitehub.payload.value"]).toEqual(observation?.payload?.visibility === "public"
      ? observation.payload.value
      : undefined)
  })

  it("marks undefined public payload values as truncated and preserves their positions", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("undefined-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          array: [undefined],
          direct: undefined,
          files: new Map([["README.md", undefined]]),
          paths: new Set([undefined]),
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.context.traceLog?.append({
      name: "workspace.undefined",
      payload: { value: undefined, visibility: "public" },
      type: "lifecycle",
    })
    await journal.context.traceLog?.append({
      name: "workspace.undefined-array",
      payload: { value: [undefined], visibility: "public" },
      type: "lifecycle",
    })
    Object.defineProperty(Array.prototype, "0", { configurable: true, value: "inherited-secret", writable: true })
    try {
      await journal.context.traceLog?.append({
        name: "workspace.sparse-array",
        payload: { value: Array(1), visibility: "public" },
        type: "lifecycle",
      })
    }
    finally {
      delete Array.prototype[0]
    }
    await journal.finish("completed")

    const observations = (await invocations.getByRunId("undefined-public-payload"))?.observations
    const observation = observations?.find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(observation?.payload).toEqual({
      value: {
        array: [null],
        files: [["README.md", null]],
        paths: [null],
      },
      visibility: "public",
    })
    expect(observations?.find(entry => entry.name === "workspace.undefined")?.payload).toEqual({
      value: null,
      visibility: "public",
    })
    for (const name of ["workspace.undefined-array", "workspace.sparse-array"]) {
      const arrayObservation = observations?.find(entry => entry.name === name)
      expect(arrayObservation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
      expect(arrayObservation?.payload).toEqual({ value: [null], visibility: "public" })
    }
  })

  it("marks each lossy public payload scalar as truncated", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("lossy-public-payload-scalars"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.bigint",
      payload: { value: 1n, visibility: "public" },
      type: "lifecycle",
    })
    await journal.context.traceLog?.append({
      name: "workspace.nan",
      payload: { value: Number.NaN, visibility: "public" },
      type: "lifecycle",
    })
    await journal.context.traceLog?.append({
      name: "workspace.negative-zero",
      payload: { value: -0, visibility: "public" },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observations = (await invocations.getByRunId("lossy-public-payload-scalars"))?.observations
    expect(observations?.find(entry => entry.name === "workspace.bigint")).toMatchObject({
      attributes: { "vitehub.observation.truncated": true },
      payload: { value: "1", visibility: "public" },
    })
    expect(observations?.find(entry => entry.name === "workspace.nan")).toMatchObject({
      attributes: { "vitehub.observation.truncated": true },
      payload: { value: null, visibility: "public" },
    })
    expect(observations?.find(entry => entry.name === "workspace.negative-zero")).toMatchObject({
      attributes: { "vitehub.observation.truncated": true },
      payload: { value: -0, visibility: "public" },
    })
  })

  it("persists the base log payload snapshot", async () => {
    let releaseEntry!: () => void
    const entryReleased = new Promise<void>(resolve => {
      releaseEntry = resolve
    })
    const onEntry = vi.fn(async () => {
      await entryReleased
    })
    const traceLog = createTraceEventLog({ onEntry })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, { ...runtime("payload-snapshot"), traceLog })
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    const value = { message: "original" }

    const appended = journal.context.traceLog?.append({
      name: "workspace.snapshot",
      payload: { value, visibility: "public" },
      type: "lifecycle",
    })
    await vi.waitFor(() => expect(onEntry).toHaveBeenCalledOnce())
    value.message = "mutated"
    releaseEntry()
    await appended
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("payload-snapshot"))?.observations
      .find(entry => entry.name === "workspace.snapshot")
    expect(observation?.payload).toEqual({ value: { message: "original" }, visibility: "public" })
  })

  it("uses the wrapped trace log timestamp for the persisted observation", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const wrappedTimestamp = "2000-01-01T00:00:00.000Z"
    const traceLog = {
      append: vi.fn(async event => ({ ...event, sequence: 1, timestamp: wrappedTimestamp })),
      entries: () => [],
    }
    const journal = await bindAgentInvocations(invocations, { ...runtime("wrapped-timestamp"), traceLog })
    if (!journal) throw new Error("Expected the invocation journal to be configured.")

    const entry = await journal.context.traceLog?.append({ name: "custom.event", type: "run" })

    expect(entry?.timestamp).toBe(wrappedTimestamp)
    await vi.waitFor(async () => {
      const observation = (await invocations.getByRunId("wrapped-timestamp"))?.observations
        .find(item => item.name === "custom.event")
      expect(observation?.timestamp).toBe(wrappedTimestamp)
    })
  })

  it("bounds large structured public payload values before persistence", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-structured-public-payload"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      name: "workspace.materialized",
      payload: {
        value: {
          bytes: new Uint8Array(100_000),
          files: new Map(Array.from({ length: 100_000 }, (_, index) => [index, index])),
          paths: new Set(Array.from({ length: 100_000 }, (_, index) => index)),
          pattern: new RegExp("x".repeat(100_000)),
        },
        visibility: "public",
      },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-structured-public-payload"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes?.["vitehub.observation.truncated"]).toBe(true)
    expect(JSON.stringify(observation?.payload).length).toBeLessThan(70_000)
  })

  it("preserves canonical trace attributes when bounding invocation observations", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const journal = await bindAgentInvocations(invocations, runtime("bounded-trace-attributes"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.context.traceLog?.append({
      activity: { owner: "vitehub", phase: "setup" },
      attributes: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`ordinary.${index}`, index])),
      name: "workspace.materialized",
      payload: { summary: "Workspace ready", visibility: "summary" },
      type: "lifecycle",
    })
    await journal.finish("completed")

    const observation = (await invocations.getByRunId("bounded-trace-attributes"))?.observations
      .find(entry => entry.name === "workspace.materialized")
    expect(observation?.attributes).toMatchObject({
      "vitehub.activity.owner": "vitehub",
      "vitehub.activity.phase": "setup",
      "vitehub.observation.truncated": true,
      "vitehub.payload.summary": "Workspace ready",
      "vitehub.payload.visibility": "summary",
    })
  })

  it("keeps resolved instructions out of metadata-only invocation journals", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      capabilities: [inspectableToolCapability()],
      channels: { reviews: { kind: "github" } },
      driver: {
        instructions: "Sensitive resolved instructions",
        model: new MockLanguageModelV3({
          doGenerate: {
            content: [{ text: "done", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
            warnings: [],
          },
        }),
      },
      invocations,
    })

    await runAgent(agent, runtime("metadata-only-instructions"), { prompt: "hello" })

    const configured = (await invocations.getByRunId("metadata-only-instructions"))?.observations
      .findLast(entry => entry.name === "vitehub.agent.configured")
    expect(configured).toMatchObject({
      activity: { owner: "vitehub", phase: "setup" },
      attributes: {
        "vitehub.activity.owner": "vitehub",
        "vitehub.activity.phase": "setup",
      },
    })
    const configurationValue = configured?.attributes?.["vitehub.agent.configuration"]
    const configuration = isRuntimeRecord(configurationValue) ? configurationValue : undefined
    expect(configuration).not.toHaveProperty("instructions")
    expect(configured?.attributes?.["vitehub.agent.configuration.fingerprint"])
      .toBe(configuration?.fingerprint)
    expect(configuration).toMatchObject({
      channels: [{ id: "reviews", kind: "github" }],
      fingerprint: expect.stringMatching(/^sha256_[a-f0-9]{64}$/),
      tools: [{ name: "search" }],
    })
    expect(JSON.stringify(configured?.attributes?.["vitehub.agent.configuration"])).not.toContain("Search indexed records")
  })

  it("retains configuration explicitly without retaining arbitrary trace content", async () => {
    const invocations = defineAgentInvocations({ configuration: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      invocations,
      capabilities: [inspectableToolCapability()],
      driver: { run: async context => {
        await context.traceLog?.append({ name: "private", type: "run", attributes: { "input.prompt": "private prompt" } })
        return "done"
      } },
    })
    await runAgent(agent, runtime("configuration-only"), { prompt: "hello" })
    const record = await invocations.getByRunId("configuration-only")
    const configured = record?.observations.findLast(entry => entry.name === "vitehub.agent.configured")
    expect(JSON.stringify(configured?.attributes?.["vitehub.agent.configuration"])).toContain("Search indexed records")
    const privateEvent = record?.observations.find(entry => entry.name === "private")
    expect(JSON.stringify(privateEvent)).not.toContain("private prompt")
  })

  it("persists resolved instructions when invocation content is enabled", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const invocations = defineAgentInvocations({
      content: "content",
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      capabilities: [inspectableToolCapability()],
      driver: {
        instructions: "Inspectable resolved instructions",
        model: new MockLanguageModelV3({
          doGenerate: {
            content: [{ text: "done", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
            warnings: [],
          },
        }),
      },
      invocations,
    })

    await runAgent(agent, runtime("content-instructions"), { prompt: "hello" })

    const configured = (await invocations.getByRunId("content-instructions"))?.observations
      .findLast(entry => entry.name === "vitehub.agent.configured")
    expect(configured?.attributes?.["vitehub.agent.configuration"]).toMatchObject({
      instructions: ["Inspectable resolved instructions"],
      tools: [{
        description: "Search indexed records.",
        inputSchema: {
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
          type: "object",
        },
        name: "search",
      }],
    })
  })

  it("persists exact tool descriptions for content-enabled Console inspection", async () => {
    const { MockLanguageModelV3 } = await import("ai/test")
    const invocations = defineAgentInvocations({
      content: "content",
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "lookup",
        tools: {
          lookup: {
            description: `  Find matching records.\n${"Detailed guidance. ".repeat(20)}  `,
            execute: () => "unused",
            name: "lookup",
          },
        },
      })],
      driver: {
        model: new MockLanguageModelV3({
          doGenerate: {
            content: [{ text: "done", type: "text" }],
            finishReason: { raw: "stop", unified: "stop" },
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
            warnings: [],
          },
        }),
      },
      invocations,
    })

    await runAgent(agent, runtime("tool-descriptions"), { prompt: "hello" })

    const configured = (await invocations.getByRunId("tool-descriptions"))?.observations
      .findLast(entry => entry.name === "vitehub.agent.configured")
    // SAFETY: The invocation configuration event owns the asserted, JSON-compatible tools projection.
    const configuration = configured?.attributes?.["vitehub.agent.configuration"] as { tools?: { description?: string, name: string }[] } | undefined
    expect(configuration?.tools).toEqual([expect.objectContaining({
      description: `  Find matching records.\n${"Detailed guidance. ".repeat(20)}  `,
      name: "lookup",
    })])
    expect(configuration?.tools?.[0]?.description).toContain("\n")
  })

  it("does not reacquire journal ownership for observations appended after finish", async () => {
    const memory = createMemoryAgentInvocationStore()
    const claim = vi.fn(memory.claim)
    const invocations = defineAgentInvocations({ store: { ...memory, claim } })
    let appendTrace: ((event: { name: string, type: "run" }) => unknown) | undefined
    const agent = defineAgent({
      driver: { run(context) {
        appendTrace = context.traceLog?.append.bind(context.traceLog)
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime("late-observation"), {})).resolves.toBe("done")
    const claimsAfterFinish = claim.mock.calls.length
    await appendTrace?.({ name: "late", type: "run" })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(claim).toHaveBeenCalledTimes(claimsAfterFinish)
    expect((await invocations.getByRunId("late-observation"))?.observations.some(entry => entry.name === "late")).toBe(false)
  })

  it("keeps claim ownership for long-running invocations", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const claim = vi.fn(memory.claim)
      const invocations = defineAgentInvocations({ store: { ...memory, claim } })
      const journal = await bindAgentInvocations(invocations, runtime("long-running"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()

      await vi.advanceTimersByTimeAsync(60 * 60_000 + 30_000)
      const claimsAfterFirstHour = claim.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)

      expect(claim.mock.calls.length).toBeGreaterThan(claimsAfterFirstHour)
      await journal.finish("completed")
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("releases a heartbeat claim completed after terminalization", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseClaim: (() => void) | undefined
      const claim = vi.fn(async (...args: Parameters<typeof memory.claim>) => {
        if (claim.mock.calls.length === 3) {
          await new Promise<void>((resolve) => { releaseClaim = resolve })
        }
        return memory.claim(...args)
      })
      const invocations = defineAgentInvocations({ store: { ...memory, claim } })
      const journal = await bindAgentInvocations(invocations, runtime("terminal-heartbeat"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()

      await vi.advanceTimersByTimeAsync(10_000)
      await journal.finish("completed")
      releaseClaim?.()
      await vi.advanceTimersByTimeAsync(0)

      const record = await invocations.getByRunId("terminal-heartbeat")
      expect(record && await memory.claim(record.id, "post-terminal", 30_000)).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not queue terminal writes behind stalled observations", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          update(id, input, claimId) {
            if (input.observation) return new Promise(() => {})
            return memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("stalled-observations"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      for (let index = 0; index < 100; index++) {
        journal.context.traceLog?.append({ name: `event-${index}`, type: "run" })
      }

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(1_000)
      await finishing

      expect((await invocations.getByRunId("stalled-observations"))?.status).toBe("completed")
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("prioritizes outcome evidence ahead of a saturated pending observation queue", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseActive!: () => void
      let reportActiveStarted!: () => void
      let reportTerminalPersisted!: () => void
      const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const terminalPersisted = new Promise<void>((resolve) => { reportTerminalPersisted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              await activeGate
            }
            else if (input.observation
              && input.observation.name !== "agent.stream.error"
              && input.observation.name !== "agent.invocation.finish") {
              return new Promise(() => {})
            }
            const updated = await memory.update(id, input, claimId)
            if (input.observation?.name === "agent.invocation.finish") reportTerminalPersisted()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("prioritized-outcome-observations"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      for (let index = 0; index < 255; index++) {
        await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
      }
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider stream failed" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider stream failed"))
      releaseActive()
      await terminalPersisted
      await vi.advanceTimersByTimeAsync(1_000)
      await finishing

      const record = await invocations.getByRunId("prioritized-outcome-observations")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations.map(observation => observation.name)).toEqual([
        "active",
        "agent.stream.error",
        "agent.invocation.finish",
      ])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("persists queued outcomes when the active observation reaches the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportActiveStarted!: () => void
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-outcomes"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider stream failed" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider stream failed"))
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing

      const record = await invocations.getByRunId("finish-deadline-outcomes")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations).toContainEqual(expect.objectContaining({ name: "agent.stream.error" }))
      expect(record?.observations.at(-1)).toMatchObject({ name: "agent.invocation.finish" })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("recovers every identified outcome missed before delivery terminalizes", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportActiveStarted!: () => void
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const recoveryTasks: Array<Promise<unknown>> = []
      const attempts = new Map<string, number>()
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          async update(id, input, claimId) {
            const name = input.observation?.name
            if (name === "active") {
              reportActiveStarted()
              return await new Promise(() => {})
            }
            if (name) {
              const attempt = attempts.get(name) || 0
              attempts.set(name, attempt + 1)
              if ((name === "run.error" || name === "agent.invocation.finish") && attempt < 2) return
              if (name === "agent.channel.delivery.effect" && attempt === 0) return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, {
        ...runtime("finish-deadline-mixed-outcomes"),
        waitUntil: promise => recoveryTasks.push(promise),
      })
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider run failed" },
        name: "run.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Failure notice" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })

      const finishing = journal.finish("failed", new Error("provider run failed"))
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing
      await Promise.all(recoveryTasks)

      const record = await invocations.getByRunId("finish-deadline-mixed-outcomes")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "run.error" }),
        expect.objectContaining({ name: "agent.invocation.finish" }),
        expect.objectContaining({ name: "agent.channel.delivery.effect" }),
      ]))
      expect(attempts).toEqual(new Map([
        ["run.error", 3],
        ["agent.invocation.finish", 3],
        ["agent.channel.delivery.effect", 2],
      ]))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("persists a queued delivery when its first write reaches the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportActiveStarted!: () => void
      let deliveryAttempts = 0
      const recoveryTasks: Array<Promise<unknown>> = []
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              return await new Promise(() => {})
            }
            if (input.observation?.name === "agent.channel.delivery.effect" && deliveryAttempts++ === 0) {
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, {
        ...runtime("finish-deadline-delivery"),
        waitUntil: promise => recoveryTasks.push(promise),
      })
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Reply before finalization" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing
      await Promise.all(recoveryTasks)

      const record = await invocations.getByRunId("finish-deadline-delivery")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "channel.effect.content": "Reply before finalization" }),
        name: "agent.channel.delivery.effect",
      }))
      expect(deliveryAttempts).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not duplicate a delivery committed before a terminal update returns", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportActiveStarted!: () => void
      let deliveryUpdates = 0
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const recoveryTasks: Array<Promise<unknown>> = []
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              return await new Promise(() => {})
            }
            const record = await memory.update(id, input, claimId)
            if (input.observation?.name === "agent.channel.delivery.effect" && deliveryUpdates++ === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 1_500))
            }
            return record
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, {
        ...runtime("terminal-delivery-ambiguous-success"),
        waitUntil: promise => recoveryTasks.push(promise),
      })
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Committed reply" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing
      await Promise.all(recoveryTasks)

      const record = await invocations.getByRunId("terminal-delivery-ambiguous-success")
      expect(record?.observations.filter(observation => observation.name === "agent.channel.delivery.effect")).toHaveLength(1)
      expect(deliveryUpdates).toBe(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("retries every queued delivery that misses terminal finalization", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportActiveStarted!: () => void
      let firstDeliveryAttempts = 0
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const recoveryTasks: Array<Promise<unknown>> = []
      const invocations = defineAgentInvocations({
        content: "content",
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "active") {
              reportActiveStarted()
              return await new Promise(() => {})
            }
            if (input.observation?.attributes?.["channel.effect.content"] === "First reply") {
              const attempt = firstDeliveryAttempts++
              if (attempt === 0) return await new Promise(() => {})
              if (attempt === 1) return undefined
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, {
        ...runtime("finish-deadline-deliveries"),
        waitUntil: promise => recoveryTasks.push(promise),
      })
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "First reply" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })
      await journal.context.traceLog?.append({
        attributes: { "channel.effect.content": "Second reply" },
        name: "agent.channel.delivery.effect",
        type: "run",
      })

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing
      await Promise.all(recoveryTasks)

      const record = await invocations.getByRunId("finish-deadline-deliveries")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ "channel.effect.content": "First reply" }),
          name: "agent.channel.delivery.effect",
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "channel.effect.content": "Second reply" }),
          name: "agent.channel.delivery.effect",
        }),
      ]))
      expect(firstDeliveryAttempts).toBe(3)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("marks truncation when a queued ordinary observation reaches the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseFirst!: () => void
      let reportFirstStarted!: () => void
      let reportQueuedStarted!: () => void
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
      const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve })
      const queuedStarted = new Promise<void>((resolve) => { reportQueuedStarted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "first") {
              reportFirstStarted()
              await firstGate
            }
            if (input.observation?.name === "queued") {
              reportQueuedStarted()
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-queued-ordinary"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "first", type: "run" })
      await firstStarted
      await journal.context.traceLog?.append({ name: "queued", type: "run" })

      const finishing = journal.finish("completed")
      releaseFirst()
      await queuedStarted
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing

      const record = await invocations.getByRunId("finish-deadline-queued-ordinary")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations.map(observation => observation.name)).toEqual(["first"])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not mark truncation when a late observation persists before terminalization", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseObservation!: () => void
      let reportObservationStarted!: () => void
      const observationGate = new Promise<void>((resolve) => { releaseObservation = resolve })
      const observationStarted = new Promise<void>((resolve) => { reportObservationStarted = resolve })
      let writes = Promise.resolve()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          update(id, input, claimId) {
            const update = writes.then(async () => {
              if (input.observation?.name === "late") {
                reportObservationStarted()
                await observationGate
              }
              return await memory.update(id, input, claimId)
            })
            writes = update.then(() => undefined)
            return update
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-late-success"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "late", type: "run" })
      await observationStarted

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      releaseObservation()
      await finishing

      const record = await invocations.getByRunId("finish-deadline-late-success")
      expect(record).toMatchObject({ status: "completed" })
      expect(record?.observations.map(observation => observation.name)).toEqual(["late"])
      expect(record?.observationsTruncated).toBeUndefined()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("marks truncation when terminalization overtakes a late observation no-op", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let releaseObservation!: () => void
      let reportObservationStarted!: () => void
      let reportTerminalPersisted!: () => void
      const observationGate = new Promise<void>((resolve) => { releaseObservation = resolve })
      const observationStarted = new Promise<void>((resolve) => { reportObservationStarted = resolve })
      const terminalPersisted = new Promise<void>((resolve) => { reportTerminalPersisted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.name === "late") {
              reportObservationStarted()
              await observationGate
            }
            const updated = await memory.update(id, input, claimId)
            if (input.status === "completed") reportTerminalPersisted()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-overtakes-late-observation"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "late", type: "run" })
      await observationStarted

      const finishing = journal.finish("completed")
      await vi.advanceTimersByTimeAsync(3_000)
      await terminalPersisted
      releaseObservation()
      await finishing

      const record = await invocations.getByRunId("finish-overtakes-late-observation")
      expect(record).toMatchObject({ observationsTruncated: true, status: "completed" })
      expect(record?.observations).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("persists an active fatal observation at the finish deadline", async () => {
    vi.useFakeTimers()
    try {
      const memory = createMemoryAgentInvocationStore()
      let reportFatalStarted!: () => void
      let stallFatal = true
      const fatalStarted = new Promise<void>((resolve) => { reportFatalStarted = resolve })
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (stallFatal && input.observation?.name === "run.error") {
              stallFatal = false
              reportFatalStarted()
              return await new Promise(() => {})
            }
            return await memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("finish-deadline-active-fatal"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({
        attributes: { "error.message": "provider run failed" },
        name: "run.error",
        type: "error",
      })
      await fatalStarted
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider run failed"))
      await vi.advanceTimersByTimeAsync(3_000)
      await finishing

      const record = await invocations.getByRunId("finish-deadline-active-fatal")
      expect(record).toMatchObject({ status: "failed" })
      expect(record?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "vitehub.observation.id": expect.any(String) }),
        name: "run.error",
      }))
      expect(record?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "vitehub.observation.id": expect.any(String) }),
        name: "agent.invocation.finish",
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds a saturated pending queue containing only outcome evidence", async () => {
    // Admission bounds are independent of wall-clock store timeout recovery.
    vi.useFakeTimers()
    try {
      let releaseActive!: () => void
      let reportActiveStarted!: () => void
      let observationWrites = 0
      const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
      const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation) observationWrites++
            if (input.observation?.name === "active") {
              reportActiveStarted()
              await activeGate
            }
            return memory.update(id, input, claimId)
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("bounded-outcome-observations"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({ name: "active", type: "run" })
      await activeStarted
      for (let index = 0; index < 512; index++) {
        await journal.context.traceLog?.append({
          attributes: { "error.message": `provider stream failed ${index}` },
          name: "agent.stream.error",
          type: "error",
        })
      }
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      const finishing = journal.finish("failed", new Error("provider stream failed"))
      releaseActive()
      await finishing

      const record = await invocations.getByRunId("bounded-outcome-observations")
      expect(observationWrites).toBeLessThanOrEqual(256)
      expect(record?.observations.length).toBeLessThanOrEqual(256)
      expect(record?.observations[1]).toMatchObject({
        attributes: {
          "error.message": "provider stream failed 258",
          "vitehub.trace.truncated": true,
        },
        name: "agent.stream.error",
      })
      expect(record?.observations.at(-1)).toMatchObject({
        attributes: { "vitehub.trace.truncated": true },
        name: "agent.invocation.finish",
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("keeps every identified priority outcome that fits before ordinary history", async () => {
    let releaseActive!: () => void
    let reportActiveStarted!: () => void
    let observationWrites = 0
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
    const activeStarted = new Promise<void>((resolve) => { reportActiveStarted = resolve })
    const memory = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        async update(id, input, claimId) {
          if (input.observation) observationWrites++
          if (input.observation?.name === "active") {
            reportActiveStarted()
            await activeGate
          }
          return memory.update(id, input, claimId)
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, runtime("ordered-outcome-observations"))
    if (!journal) throw new Error("Expected the invocation journal to be configured.")
    await journal.running()
    await journal.context.traceLog?.append({ name: "active", type: "run" })
    await activeStarted
    for (let index = 0; index < 255; index++) {
      await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
    }
    await journal.context.traceLog?.append({
      attributes: { generation: "older" },
      name: "agent.invocation.finish",
      type: "run",
    })
    await journal.context.traceLog?.append({
      attributes: { "error.message": "fatal run error" },
      name: "run.error",
      type: "error",
    })
    await journal.context.traceLog?.append({
      attributes: { generation: "latest" },
      name: "agent.invocation.finish",
      type: "run",
    })

    const finishing = journal.finish("failed", new Error("fatal run error"))
    releaseActive()
    await finishing

    const record = await invocations.getByRunId("ordered-outcome-observations")
    expect(observationWrites).toBeLessThanOrEqual(256)
    expect(record?.observations.length).toBeLessThanOrEqual(256)
    expect(record?.observations.slice(-3)).toMatchObject([
      { attributes: { generation: "older" }, name: "agent.invocation.finish" },
      { attributes: { "error.message": "fatal run error" }, name: "run.error" },
      { attributes: { generation: "latest" }, name: "agent.invocation.finish" },
    ])
  })

  it("requeues an in-flight earliest fatal observation when its write fails", async () => {
    // This test covers retry ordering and the count limit, not the wall-clock flush deadline.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      let releaseFatal!: () => void
      let reportFatalStarted!: () => void
      let reportFatalRetried!: () => void
      let fatalWrites = 0
      let failFatal = true
      const fatalGate = new Promise<void>((resolve) => { releaseFatal = resolve })
      const fatalStarted = new Promise<void>((resolve) => { reportFatalStarted = resolve })
      const fatalRetried = new Promise<void>((resolve) => { reportFatalRetried = resolve })
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            const isEarliestFatal = input.observation?.attributes?.["error.message"] === "earliest fatal"
            if (isEarliestFatal) fatalWrites++
            if (failFatal && isEarliestFatal) {
              reportFatalStarted()
              await fatalGate
              failFatal = false
              return
            }
            const updated = await memory.update(id, input, claimId)
            if (isEarliestFatal) reportFatalRetried()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("retried-earliest-fatal"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({
        attributes: { "error.message": "earliest fatal" },
        name: "agent.stream.error",
        type: "error",
      })
      await fatalStarted
      for (let index = 0; index < 255; index++) {
        await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
      }
      await journal.context.traceLog?.append({
        attributes: { "error.message": "later fatal" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      releaseFatal()
      await fatalRetried
      expect(fatalWrites).toBe(2)
      await journal.finish("failed", new Error("earliest fatal"))

      const record = await invocations.getByRunId("retried-earliest-fatal")
      expect(record?.observations).toHaveLength(256)
      expect(record?.observations.filter(observation => outcomeObservationNames.has(observation.name))).toMatchObject([
        { attributes: { "error.message": "earliest fatal" }, name: "agent.stream.error" },
        { attributes: { "error.message": "later fatal" }, name: "agent.stream.error" },
        { name: "agent.invocation.finish" },
      ])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("requeues an in-flight earliest fatal observation after its write times out", async () => {
    vi.useFakeTimers()
    try {
      let fatalWrites = 0
      let reportFatalStarted!: () => void
      let reportTerminalPersisted!: () => void
      let settleLateFatal!: () => Promise<void>
      const fatalStarted = new Promise<void>((resolve) => { reportFatalStarted = resolve })
      const terminalPersisted = new Promise<void>((resolve) => { reportTerminalPersisted = resolve })
      const memory = createMemoryAgentInvocationStore()
      const invocations = defineAgentInvocations({
        store: {
          ...memory,
          async update(id, input, claimId) {
            if (input.observation?.attributes?.["error.message"] === "earliest fatal" && fatalWrites++ === 0) {
              reportFatalStarted()
              return new Promise((resolve) => {
                settleLateFatal = async () => { resolve(await memory.update(id, input, claimId)) }
              })
            }
            const updated = await memory.update(id, input, claimId)
            if (input.observation?.name === "agent.invocation.finish") reportTerminalPersisted()
            return updated
          },
        },
      })
      const journal = await bindAgentInvocations(invocations, runtime("timed-out-earliest-fatal"))
      if (!journal) throw new Error("Expected the invocation journal to be configured.")
      await journal.running()
      await journal.context.traceLog?.append({
        attributes: { "error.message": "earliest fatal" },
        name: "agent.stream.error",
        type: "error",
      })
      await fatalStarted
      for (let index = 0; index < 255; index++) {
        await journal.context.traceLog?.append({ name: `ordinary-${index}`, type: "run" })
      }
      await journal.context.traceLog?.append({
        attributes: { "error.message": "later fatal" },
        name: "agent.stream.error",
        type: "error",
      })
      await journal.context.traceLog?.append({ name: "agent.invocation.finish", type: "run" })

      await vi.advanceTimersByTimeAsync(1_000)
      await terminalPersisted
      await settleLateFatal()
      await journal.finish("failed", new Error("earliest fatal"))

      const record = await invocations.getByRunId("timed-out-earliest-fatal")
      expect(record?.observations).toHaveLength(256)
      expect(record?.observations.filter(observation => outcomeObservationNames.has(observation.name))).toMatchObject([
        { attributes: { "error.message": "earliest fatal" }, name: "agent.stream.error" },
        { attributes: { "error.message": "later fatal" }, name: "agent.stream.error" },
        { name: "agent.invocation.finish" },
      ])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("terminalizes records created after the store timeout", async () => {
    const memory = createMemoryAgentInvocationStore()
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        async create(input) {
          await createGate
          return memory.create(input)
        },
      },
    })
    const run = vi.fn(() => "done")
    const invocation = runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("late-create"), {})

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce(), { timeout: 2_000 })
    releaseCreate()
    await expect(invocation).resolves.toBe("done")
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("late-create")).resolves.toMatchObject({ status: "completed" })
    }, { timeout: 2_500 })
  }, 5_000)

  it("records safe lifecycle observations while keeping list rows bounded", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    let runtimeTraceId: string | undefined
    const agent = defineAgent({
      driver: { run: (context) => {
        runtimeTraceId = context.trace?.id
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime("run-1", {
      "github.pull_request.number": 42,
      "github.repository": "vite-hub/vitehub",
      "secret key": "omitted",
    }), {})).resolves.toBe("done")

    const record = await invocations.getByRunId("run-1")
    expect(record).toMatchObject({
      annotations: {
        "github.pull_request.number": 42,
        "github.repository": "vite-hub/vitehub",
      },
      id: expect.stringMatching(/^sha256_[\da-f]{64}$/),
      status: "completed",
      traceId: expect.stringMatching(/^sha256_[\da-f]{64}$/),
    })
    expect(record?.annotations).not.toHaveProperty("secret key")
    expect(record?.observations.map(event => event.name)).toEqual([
      "vitehub.agent.configured",
      "agent.invocation.start",
      "agent.invocation.finish",
    ])
    expect(record?.observations.every(event => event.attributes?.prompt === undefined)).toBe(true)
    expect(record?.observations.every(event => event.trace?.id === record.traceId)).toBe(true)
    expect(runtimeTraceId).toBe("run-1")

    const listed = await invocations.list()
    expect(listed.invocations).toHaveLength(1)
    expect(listed.invocations[0]).not.toHaveProperty("observations")
    await expect(invocations.list({ search: "VITE-HUB/VITEHUB" })).resolves.toMatchObject({
      invocations: [expect.objectContaining({ status: "completed" })],
    })
    await expect(invocations.list({ search: "observation-only content" })).resolves.toEqual({ invocations: [] })
    await expect(invocations.list({ cursor: "invalid" })).rejects.toThrow("cursor is invalid")
  })

  it.each(["content", "metadata"] as const)("redacts terminal result credentials under the %s capture policy", async (content) => {
    const answer = 'PASSWORD="sensitive words";status=ok'
    const invocations = defineAgentInvocations({ content, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: { "message.content": answer, "message.id": "answer", "message.role": "assistant" },
          name: "agent.message.delta",
          type: "run",
        })
        return answer
      } },
      invocations,
      runtime: false,
    })
    await expect(runAgent(agent, runtime("terminal-credential"), {})).resolves.toBe(answer)
    const observations = (await invocations.getByRunId("terminal-credential"))?.observations ?? []
    const finish = observations.find(entry => entry.name === "agent.invocation.finish")
    expect(finish).toBeDefined()
    expect(finish?.attributes?.["result.text"]).toBe(content === "content" ? 'PASSWORD="[REDACTED]";status=ok' : undefined)
    expect(JSON.stringify(observations)).not.toContain("sensitive words")
  })

  it("bounds admitted message streams without losing credential boundary state", async () => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxCount: 8 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        const delta = (id: string, text: string) => context.traceLog?.append({
          name: "agent.message.delta",
          type: "run",
          attributes: { "message.id": id, "message.content": text },
        })
        await delta("answer", "Authorization: Bear")
        for (let index = 0; index < 100; index++) await delta(`stream-${index}`, "short")
        await context.traceLog?.append({ name: "checkpoint", type: "run" })
        await delta("stream-99", "er dropped-secret")
        await delta("answer", "er retained-secret;status=ok")
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("bounded-streams"), {})
    const observations = (await invocations.getByRunId("bounded-streams"))?.observations || []
    const serialized = JSON.stringify(observations)
    expect(serialized).not.toContain("retained-secret")
    expect(serialized).not.toContain("dropped-secret")
    expect(observations.some(entry => entry.attributes?.["content.truncated"])).toBe(true)
  })

  it("preserves the configured trace content policy and coalesces message deltas", async () => {
    const run = async (
      runId: string,
      content: "content" | "metadata",
      traceLog = createTraceEventLog(),
    ) => {
      const invocations = defineAgentInvocations({ content, store: createMemoryAgentInvocationStore() })
      const agent = defineAgent({
        driver: { async run(context) {
          for (let index = 0; index < 300; index++) {
            await context.traceLog?.append({
              attributes: {
                "message.content": String(index % 10).repeat(2_000),
                "message.id": "answer",
                "message.role": "assistant",
              },
              name: "agent.message.delta",
              type: "run",
            })
          }
          await context.traceLog?.append({ name: "after-message", type: "run" })
          return "done"
        } },
        invocations,
        runtime: false,
      })

      await runAgent(agent, { ...runtime(runId), traceLog }, {})
      return (await invocations.getByRunId(runId))?.observations || []
    }

    const metadata = await run("metadata-content", "metadata", createTraceEventLog({ content: "content" }))
    const metadataDeltas = metadata.filter(entry => entry.name === "agent.message.delta")
    expect(metadata.map(entry => entry.name)).toEqual([
      "vitehub.agent.configured",
      "agent.invocation.start",
      ...Array.from({ length: 10 }, () => "agent.message.delta"),
      "after-message",
      "agent.invocation.finish",
    ])
    expect(metadataDeltas.every(entry => entry.attributes?.["message.content"] === undefined)).toBe(true)
    expect(metadataDeltas.every(entry => String(entry.attributes?.["content.omitted"]).includes("message.content"))).toBe(true)

    const full = await run("full-content", "content")
    const fullDeltas = full.filter(entry => entry.name === "agent.message.delta")
    expect(fullDeltas.map(entry => entry.attributes?.["message.content"]).join(""))
      .toBe(Array.from({ length: 300 }, (_, index) => String(index % 10).repeat(2_000)).join(""))
    expect(fullDeltas).toHaveLength(10)
    expect(fullDeltas.every(entry => String(entry.attributes?.["message.content"]).length <= 64 * 1024)).toBe(true)
    expect(fullDeltas.every(entry => !entry.attributes?.["content.omitted"])).toBe(true)
  })

  it.each([true, false])("keeps primary deltas when adjacent title deltas share their message identity (title first: %s)", async (titleFirst) => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const title of [titleFirst, !titleFirst]) {
          await context.traceLog?.append({
            attributes: {
              "message.content": title ? "Private title" : "Primary response",
              "message.id": "answer",
              "message.phase": "final",
              "message.role": "assistant",
              ...(title ? { "vitehub.auxiliary.kind": "title" } : {}),
            },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("title-delta-isolation"), {})
    const record = await invocations.getByRunId("title-delta-isolation")
    const deltas = record?.observations.filter(entry => entry.name === "agent.message.delta")
    expect(deltas).toHaveLength(1)
    expect(deltas?.[0]?.attributes?.["message.content"]).toBe("Primary response")
    expect(JSON.stringify(record?.observations)).not.toContain("Private title")
  })

  it.each(["content", "metadata"] as const)("retains title usage and diagnostics with %s capture", async (content) => {
    const invocations = defineAgentInvocations({
      content,
      metadataContent: ["message.content"],
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const event of [
          { name: "agent.message.delta", attributes: { "message.content": "Private title" } },
          { name: "vitehub.agent.configured", attributes: { "vitehub.agent.configuration": "Private configuration" } },
          { name: "agent.usage", attributes: { "usage.total_tokens": 12, "message.content": "Private usage content" } },
          { name: "agent.provider.error", attributes: { "error.type": "ProviderTimeout", "message.content": "Private diagnostic content" } },
        ]) {
          await context.traceLog?.append({
            ...event,
            attributes: { ...event.attributes, "vitehub.auxiliary.kind": "title" },
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("title-diagnostics"), {})
    const observations = (await invocations.getByRunId("title-diagnostics"))?.observations ?? []
    const titleEvents = observations.filter(entry => entry.attributes?.["vitehub.auxiliary.kind"] === "title")
    expect(titleEvents.map(entry => entry.name)).toEqual(["agent.usage", "agent.provider.error"])
    expect(titleEvents[0]?.attributes?.["usage.total_tokens"]).toBe(12)
    expect(titleEvents[1]?.attributes?.["error.type"]).toBe("ProviderTimeout")
    expect(JSON.stringify(observations)).not.toContain("Private")
  })

  it("preserves privacy filtering when coalesced message content crosses the former chunk boundary", async () => {
    const first = `${"x".repeat(8)}Authorization: Bear`
    const secret = `sensitive-${"x".repeat(700)}`
    const deltas = [first, `er ${secret.slice(0, 300)}`, secret.slice(300, 600), secret.slice(600), " complete"]
    const run = async (runId: string, content: "content" | "metadata") => {
      const invocations = defineAgentInvocations({
        content,
        observations: { maxStringLength: 10 },
        store: createMemoryAgentInvocationStore(),
      })
      const agent = defineAgent({
        driver: { async run(context) {
          for (const value of deltas) {
            await context.traceLog?.append({
              attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
              name: "agent.message.delta",
              type: "run",
            })
            if (value === first) {
              await context.traceLog?.append({
                attributes: { "usage.total_tokens": 12 },
                name: "agent.usage",
                type: "run",
              })
              await context.traceLog?.append({
                attributes: {
                  "message.content": "Private title",
                  "message.id": "answer",
                  "message.role": "assistant",
                  "vitehub.auxiliary.kind": "title",
                },
                name: "agent.message.delta",
                type: "run",
              })
            }
          }
          return "done"
        } },
        invocations,
        runtime: false,
      })
      await runAgent(agent, { ...runtime(runId), traceLog: createTraceEventLog({ content: "content" }) }, {})
      return (await invocations.getByRunId(runId))?.observations || []
    }

    const metadata = await run("private-coalesced-message", "metadata")
    expect(JSON.stringify(metadata)).not.toContain(secret)
    expect(metadata.find(entry => entry.name === "agent.message.delta")?.attributes?.["content.omitted"]).toBeDefined()

    const content = await run("exported-coalesced-message", "content")
    expect(content.filter(entry => entry.name === "agent.message.delta").length).toBeGreaterThan(1)
    expect(content.filter(entry => entry.name === "agent.message.delta").map(entry => entry.attributes?.["message.content"]).join(""))
      .toContain("Authorization: Bearer [REDACTED]")
    expect(JSON.stringify(content)).not.toContain(secret)
    expect(JSON.stringify(content)).not.toContain("Private title")
    expect(JSON.stringify(traceEventsToOpenTelemetrySpans(content, { content: "metadata" }))).not.toContain(secret)
  })

  it.each([true, false])("preserves chunk content and identity with content-first attributes %s", async (contentFirst) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const expected = "message text ".repeat(40)
    const identity = {
      "agent.run.id": "budget-order",
      "message.id": "answer",
      "message.phase": "final",
      "message.role": "assistant",
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: contentFirst
            ? { "message.content": expected, ...identity }
            : { ...identity, "message.content": expected },
          name: "agent.message.delta",
          type: "run",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("budget-order"), {})
    const observations = (await invocations.getByRunId("budget-order"))?.observations ?? []
    const deltas = observations.filter(entry => entry.name === "agent.message.delta")
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map(entry => entry.attributes?.["message.content"]).join("")).toBe(expected)
    for (const delta of deltas) {
      expect(delta.attributes).toMatchObject(identity)
      expect(delta.attributes?.["vitehub.observation.truncated"]).toBeUndefined()
      expect(String(delta.attributes?.["message.content"]).length).toBeLessThanOrEqual(128)
    }
  })

  it.each([
    { head: '{"password":', tail: ' "sensitive-value","status":"ok"}', expected: '{"password":[REDACTED],"status":"ok"}' },
    { head: "password ", tail: '= "correct horse";status=ok', expected: 'password = "[REDACTED]";status=ok' },
  ])("redacts structured credentials after a bounded $head chunk", async ({ head, tail, expected }) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const prefix = ".".repeat(512)
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [prefix + head, tail]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("structured-credential"), {})
    const observations = (await invocations.getByRunId("structured-credential"))?.observations ?? []
    expect(observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")).toBe(prefix + expected)
  })

  it.each(["Authorization:", "Authorization: ", "Proxy-Authorization: "])("retains a bounded %s header before its scheme", async (header) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxStringLength: 128 }, store: createMemoryAgentInvocationStore() })
    const prefix = ".".repeat(512)
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [prefix + header, " basic c2VjcmV0;status=ok"]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("split-authorization-header"), {})
    const observations = (await invocations.getByRunId("split-authorization-header"))?.observations ?? []
    expect(observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")).toBe(`${prefix}${header} basic [REDACTED];status=ok`)
  })

  it("redacts a camel-case credential split at a bounded journal flush", async () => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const prefix = ".".repeat(512)
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`${prefix}apiT`, "oken=sensitive-value;status=ok"]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("split-camel-credential"), {})
    const observations = (await invocations.getByRunId("split-camel-credential"))?.observations ?? []
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`${prefix}apiToken=[REDACTED];status=ok`)
  })

  it("does not detach a closed marker-like credential from its assignment", async () => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const prefix = ".".repeat(512)
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: { "message.content": `${prefix}PASSWORD="secret"`, "message.id": "answer" },
          name: "agent.message.delta",
          type: "run",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("closed-credential"), {})
    const observations = (await invocations.getByRunId("closed-credential"))!.observations
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`${prefix}PASSWORD="[REDACTED]"`)
  })

  it.each([0, 1, 2])("preserves evidence after a single-quoted backslash at split %s", async (split) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const ending = "\\';status=ok"
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`SECRET='${"private".repeat(100)}${ending.slice(0, split)}`, ending.slice(split)]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("single-quoted-backslash"), {})
    const observations = (await invocations.getByRunId("single-quoted-backslash"))!.observations
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe("SECRET='[REDACTED]';status=ok")
  })

  it.each([false, true])("redacts adjacent shell segments across bounded chunks (quoted start: %s)", async (quotedStart) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        const start = quotedStart ? '"' : ""
        const chunks = [`PASSWORD=${start}${"private".repeat(100)}`, '"', "secret words", '"', "tail", ";status=ok"]
        if (quotedStart) chunks.splice(1, 0, '"')
        for (const value of chunks) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("shell-segments"), {})
    const observations = (await invocations.getByRunId("shell-segments"))!.observations
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(quotedStart ? 'PASSWORD="[REDACTED]";status=ok' : "PASSWORD=[REDACTED];status=ok")
  })

  it.each(["<", ">"].flatMap(marker => [false, true].map(substitution => ({ marker, substitution }))))
  ("preserves split process markers in bounded journals: %j", async ({ marker, substitution }) => {
    const invocations = defineAgentInvocations({ content: "content", observations: { maxStringLength: 128 }, store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        const chunks = [`PASSWORD=${"private".repeat(100)}${marker}`, "", substitution ? "(cat private-file);status=ok" : "public-file;status=ok"]
        for (const value of chunks) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("split-process-marker"), {})
    const observations = (await invocations.getByRunId("split-process-marker"))!.observations
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`PASSWORD=[REDACTED]${substitution ? "" : `${marker}public-file`};status=ok`)
  })

  it.each([["$(", ")"], ["`", "`"]])("redacts shell substitutions across bounded chunks: %s", async (open, close) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        const chunks = [`PASSWORD=${open}printf ${"private".repeat(100)}`, " secret words", close, ";status=ok"]
        for (const value of chunks) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("shell-segments"), {})
    const observations = (await invocations.getByRunId("shell-segments"))!.observations
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe("PASSWORD=[REDACTED];status=ok")
  })

  it.each(["PASSWORD=", "Bearer ", "Authorization: basic "].flatMap(prefix => ['"', "'"].map(quote => [prefix, quote])))
  ("redacts quoted credentials across bounded chunks with %s%s", async (credentialPrefix, quote) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`${credentialPrefix}${quote}${"secret word ".repeat(50)}`, "more private words", `${quote};status=ok`]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("quoted-password"), {})
    const observations = (await invocations.getByRunId("quoted-password"))?.observations ?? []
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`${credentialPrefix}${quote}[REDACTED]${quote};status=ok`)
  })

  it.each(["PASSWORD=", "Bearer ", "Authorization: basic "].flatMap(prefix => ['"', "'"].map(quote => [prefix, quote])))
  ("redacts a quoted credential when its opening %s%s arrives after a flush", async (credentialPrefix, quote) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const prefix = ".".repeat(512)
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`${prefix}${credentialPrefix}`, quote, "secret", quote, ";status=ok"]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("split-quoted-password"), {})
    const observations = (await invocations.getByRunId("split-quoted-password"))?.observations ?? []
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`${prefix}${credentialPrefix}[REDACTED];status=ok`)
  })

  it.each(["Bearer", "Basic", "Authorization: basic", "Authorization: BASIC"])("redacts %s credentials after a bounded scheme-only chunk", async (scheme) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 10 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`${".".repeat(512)}${scheme}`, " ", " sensitive-value", " continued"]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime(`scheme-boundary-${scheme}`), {})
    const observations = (await invocations.getByRunId(`scheme-boundary-${scheme}`))?.observations ?? []
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).not.toContain("sensitive-value")
    expect(text).toContain(" continued")
  })

  it.each(["Bearer ", "Basic ", "API_TOKEN=", "password=", "apiToken="])("marks redaction after a bounded separator-only prefix %s", async (prefix) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`${".".repeat(512)}${prefix}`, "sensitive", "-value", " continued"]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("separator-boundary"), {})
    const observations = (await invocations.getByRunId("separator-boundary"))?.observations ?? []
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`${".".repeat(512)}${prefix}[REDACTED] continued`)
    expect(JSON.stringify(observations)).not.toContain("sensitive")
  })

  it.each([
    ["Bear", "er sensitive-value", "Bearer [REDACTED]"],
    ["Bas", "ic sensitive-value", "Basic [REDACTED]"],
    ["pass", "word", "password"],
    ["sec", "tion", "section"],
  ])("retains an unconfirmed bounded marker %s until its continuation arrives", async (prefix, continuation, expected) => {
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxStringLength: 128 },
      store: createMemoryAgentInvocationStore(),
    })
    const agent = defineAgent({
      driver: { async run(context) {
        for (const value of [`${".".repeat(512)}${prefix}`, continuation, " complete"]) {
          await context.traceLog?.append({
            attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
          await context.traceLog?.append({ name: "checkpoint", type: "run" })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })
    await runAgent(agent, runtime("bounded-marker"), {})
    const observations = (await invocations.getByRunId("bounded-marker"))?.observations ?? []
    const text = observations.filter(entry => entry.name === "agent.message.delta")
      .map(entry => entry.attributes?.["message.content"]).join("")
    expect(text).toBe(`${".".repeat(512)}${expected} complete`)
    expect(JSON.stringify(observations)).not.toContain("sensitive-value")
  })

  it.each(["Bearer", "Basic"])("preserves structured suffixes after %s credentials across flush boundaries", async (scheme) => {
    for (const padding of ["", ".".repeat(512)]) {
      const invocations = defineAgentInvocations({
        content: "content",
        observations: { maxStringLength: 128 },
        store: createMemoryAgentInvocationStore(),
      })
      const agent = defineAgent({
        driver: { async run(context) {
          for (const value of [padding + '{"authorization":"' + scheme + " sensitive", '-value","status":"ok"}']) {
            await context.traceLog?.append({
              attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
              name: "agent.message.delta",
              type: "run",
            })
            await context.traceLog?.append({ name: "checkpoint", type: "run" })
          }
          return "done"
        } },
        invocations,
        runtime: false,
      })
      await runAgent(agent, runtime("structured-credential"), {})
      const observations = (await invocations.getByRunId("structured-credential"))?.observations ?? []
      const text = observations.filter(entry => entry.name === "agent.message.delta")
        .map(entry => entry.attributes?.["message.content"]).join("")
      expect(text).toBe(padding + '{"authorization":"' + scheme + ' [REDACTED]","status":"ok"}')
      expect(JSON.stringify(observations)).not.toContain("sensitive")
    }
  })

  it.each(["Bearer ", "Basic ", "API_TOKEN="])("preserves ampersand suffixes after %s credentials across flush boundaries", async (marker) => {
    for (const padding of ["", ".".repeat(512)]) {
      const invocations = defineAgentInvocations({
        content: "content",
        observations: { maxStringLength: 128 },
        store: createMemoryAgentInvocationStore(),
      })
      const agent = defineAgent({
        driver: { async run(context) {
          for (const value of [padding + marker + "sensitive", "-value&status=ok"]) {
            await context.traceLog?.append({
              attributes: { "message.content": value, "message.id": "answer", "message.role": "assistant" },
              name: "agent.message.delta",
              type: "run",
            })
            await context.traceLog?.append({ name: "checkpoint", type: "run" })
          }
          return "done"
        } },
        invocations,
        runtime: false,
      })
      await runAgent(agent, runtime("ampersand-credential"), {})
      const observations = (await invocations.getByRunId("ampersand-credential"))?.observations ?? []
      const text = observations.filter(entry => entry.name === "agent.message.delta")
        .map(entry => entry.attributes?.["message.content"]).join("")
      expect(text).toBe(padding + marker + "[REDACTED]&status=ok")
      expect(JSON.stringify(observations)).not.toContain("sensitive")
    }
  })

  it.each(["failed", "cancelled"] as const)("retains buffered response evidence when an invocation is %s", async (status) => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const abort = new AbortController()
    const failure = new Error("stopped")
    const runId = `buffered-${status}`
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: { "message.content": "Basic", "message.id": "answer", "message.role": "assistant" },
          name: "agent.message.delta",
          type: "run",
        })
        if (status === "cancelled") abort.abort(failure)
        throw failure
      } },
      invocations,
      runtime: false,
    })

    await expect(runAgent(agent, runtime(runId), { abortSignal: abort.signal })).rejects.toThrow("stopped")

    const record = await invocations.getByRunId(runId)
    expect(record?.status).toBe(status)
    const observations = record?.observations ?? []
    const deltas = observations.filter(entry => entry.name === "agent.message.delta")
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.attributes?.["message.content"]).toBe("Basic")
    const terminal = observations.find(entry => entry.name === (status === "failed" ? "agent.invocation.error" : "agent.invocation.cancelled"))
    expect(terminal).toBeDefined()
    expect(deltas[0]!.sequence).toBeLessThan(terminal!.sequence)
  })

  it.each(["abort", "stream return"] as const)("preserves %s cancellation after journal finalization rejects", async (cancellation) => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const abort = new AbortController()
    const failure = new Error("stopped")
    const finishFailure = new Error("journal finish failed")
    const traceLog = createTraceEventLog()
    const originalBind = invocationModule.bindAgentInvocations
    const bind = vi.spyOn(invocationModule, "bindAgentInvocations").mockImplementation(async (...args) => {
      const journal = await originalBind(...args)
      if (!journal) return journal
      const originalFinish = journal.finish.bind(journal)
      journal.finish = vi.fn(originalFinish).mockRejectedValueOnce(finishFailure)
      return journal
    })
    try {
      const agent = defineAgent({
        driver: cancellation === "abort" ? { run() {
          abort.abort(failure)
          throw failure
        } } : { async *run() {
          yield { id: "reply", text: "Partial", type: "text-delta" as const }
          yield { id: "reply", text: " answer", type: "text-delta" as const }
        } },
        invocations,
        runtime: false,
      })
      const context = { ...runtime("cancelled-finish-error"), traceLog }
      if (cancellation === "abort") {
        await expect(runAgent(agent, context, { abortSignal: abort.signal })).rejects.toThrow()
      }
      else {
        const stream = await streamAgent(agent, context, { abortSignal: abort.signal })
        // SAFETY: this driver is an async generator, so streamAgent returns its async iterable.
        const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        expect((await iterator.next()).done).toBe(false)
        await expect(iterator.return!()).rejects.toThrow("journal finish failed")
        expect(abort.signal.aborted).toBe(false)
      }

      const terminals = traceLog.entries().filter(entry => [
        "agent.invocation.cancelled", "agent.invocation.error",
      ].includes(entry.name ?? ""))
      const firstCancellation = terminals.findIndex(entry => entry.name === "agent.invocation.cancelled")
      expect(firstCancellation).toBeGreaterThanOrEqual(0)
      expect(terminals.slice(firstCancellation + 1).some(entry => entry.name === "agent.invocation.error")).toBe(true)
      expect(terminals.at(-1)?.name).toBe("agent.invocation.cancelled")
      expect(deriveTraceRuns(traceLog.entries())).toMatchObject([{ status: "cancelled" }])
      expect(await invocations.getByRunId("cancelled-finish-error")).toMatchObject({ status: "cancelled" })
    }
    finally {
      bind.mockRestore()
    }
  })

  it("persists bounded message chunks while an invocation is still running", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    let runningObservations: string[] = []
    const agent = defineAgent({
      driver: { async run(context) {
        for (let index = 0; index < 32; index++) {
          await context.traceLog?.append({
            attributes: { "message.content": "STATUS", "message.id": "answer", "message.role": "assistant" },
            name: "agent.message.delta",
            type: "run",
          })
        }
        await Promise.resolve()
        runningObservations = (await invocations.getByRunId("live-deltas"))?.observations.map(entry => entry.name) ?? []
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("live-deltas"), {})

    expect(runningObservations).toContain("agent.message.delta")
  })

  it("preserves message phases and approval inputs through invocation tracing", async () => {
    const invocations = defineAgentInvocations({ content: "content", store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async *run() {
        yield { id: "reply", phase: "commentary" as const, text: "Checking.", type: "text-delta" as const }
        yield { id: "reply", phase: "final" as const, text: "Done.", type: "text-delta" as const }
        yield { id: "approval", input: { command: "pnpm test" }, name: "Run command", type: "approval-request" as const }
      } },
      invocations,
      runtime: false,
    })

    const stream = await streamAgent(agent, {
      ...runtime("phased-trace"),
      traceLog: createTraceEventLog({ content: "content" }),
    }, {})
    // SAFETY: this driver is an async generator, so streamAgent returns its async iterable.
    for await (const _event of stream as AsyncIterable<unknown>) {}

    const observations = (await invocations.getByRunId("phased-trace"))?.observations ?? []
    expect(observations.filter(event => event.name === "agent.message.delta").map(event => event.attributes?.["message.phase"]))
      .toEqual(["commentary", "final"])
    expect(observations.find(event => event.name === "agent.approval.request")?.attributes)
      .toMatchObject({ "approval.input": { command: "pnpm test" } })
  })

  it("normalizes non-finite observation numbers across stores", async () => {
    const memory = createMemoryAgentInvocationStore()
    const persistedObservations: unknown[] = []
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        if (input.observation) persistedObservations.push(input.observation)
        return memory.update(id, input, claimId)
      },
    }
    const invocations = defineAgentInvocations({ store })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          attributes: { finite: 1, nan: Number.NaN, negative: Number.NEGATIVE_INFINITY, positive: Number.POSITIVE_INFINITY },
          name: "numbers",
          type: "run",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("observation-numbers"), {})
    const observation = (await invocations.getByRunId("observation-numbers"))?.observations
      .find(event => event.name === "numbers")
    expect(observation?.attributes).toMatchObject({ finite: 1, nan: null, negative: null, positive: null })
    expect(persistedObservations).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({ nan: null, negative: null, positive: null }),
    }))
  })

  it("normalizes invalid custom trace sequences before journal storage", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const entries: Array<Record<string, unknown>> = []
    const traceLog = {
      append: vi.fn(async (event: Record<string, unknown>) => {
        const customSequences = [Number.MAX_SAFE_INTEGER, 1, Number.NaN]
        const entry = { ...event, sequence: customSequences[entries.length] }
        entries.push(entry)
        return entry
      }),
      entries: () => entries,
    }
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({ name: "custom", type: "run" })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
    await runAgent(agent, { ...runtime("custom-sequence"), traceLog } as never, {})
    const observations = (await invocations.getByRunId("custom-sequence"))?.observations || []
    expect(observations.map(observation => observation.sequence)).toEqual([1, 2, 3, 4])
    expect(observations.every(observation => Number.isSafeInteger(observation.sequence))).toBe(true)
  })

  it("stops observation writes at the durable cap and retries terminal writes", async () => {
    const memory = createMemoryAgentInvocationStore()
    let terminalFailures = 1
    let updates = 0
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        updates++
        if (input.status === "completed" && terminalFailures-- > 0) return
        return memory.update(id, input, claimId)
      },
    }
    const invocations = defineAgentInvocations({ store })
    const agent = defineAgent({
      driver: { async run(context) {
        await context.traceLog?.append({
          name: "invalid-timestamp",
          timestamp: "x".repeat(10_000),
          type: "run",
        })
        for (let index = 0; index < 300; index++) {
          await context.traceLog?.append({ name: `event-${index}`, type: "run" })
        }
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("bounded-observations"), {})

    await vi.waitFor(async () => {
      expect(await invocations.getByRunId("bounded-observations")).toMatchObject({ status: "completed" })
    }, { timeout: 2_000 })
    const record = await invocations.getByRunId("bounded-observations")
    expect(record).toMatchObject({ status: "completed" })
    expect(record?.observations).toHaveLength(256)
    expect(record?.observations.at(-1)).toMatchObject({
      attributes: { "vitehub.trace.truncated": true },
      name: "agent.invocation.finish",
    })
    expect(record?.observations[1]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(record?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(updates).toBeLessThanOrEqual(261)
  })

  it("retains fatal stream evidence and the lifecycle terminal beyond the durable cap", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: { async run(context) {
        for (let index = 0; index < 300; index++) {
          await context.traceLog?.append({ name: `event-${index}`, type: "run" })
        }
        await context.traceLog?.append({
          attributes: { "error.message": "provider stream failed" },
          name: "agent.stream.error",
          type: "error",
        })
        return "done"
      } },
      invocations,
      runtime: false,
    })

    await runAgent(agent, runtime("bounded-fatal-observations"), {})

    const observations = (await invocations.getByRunId("bounded-fatal-observations"))?.observations || []
    expect(observations).toHaveLength(256)
    expect(observations.slice(-2)).toMatchObject([
      {
        attributes: {
          "error.message": "provider stream failed",
          "vitehub.trace.truncated": true,
        },
        name: "agent.stream.error",
      },
      {
        attributes: { "vitehub.trace.truncated": true },
        name: "agent.invocation.finish",
      },
    ])
  })

  it("records cancellation while an invocation waits for driver capacity", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        capacity: { concurrency: 1, queue: { maxPending: 1 } },
        async run() {
          await gate
          return "done"
        },
      },
      invocations,
      runtime: false,
    })
    const first = runAgent(agent, runtime("run-1"), {})
    await vi.waitFor(async () => expect((await invocations.getByRunId("run-1"))?.status).toBe("running"))
    const abort = new AbortController()
    const second = runAgent(agent, runtime("run-2"), { abortSignal: abort.signal })
    await vi.waitFor(async () => expect((await invocations.getByRunId("run-2"))?.status).toBe("pending"))

    abort.abort(new DOMException("stop", "AbortError"))
    await expect(second).rejects.toMatchObject({ name: "AbortError" })
    expect(await invocations.getByRunId("run-2")).toMatchObject({ status: "cancelled" })
    release()
    await expect(first).resolves.toBe("done")
  })

  it("records preparation failures before capacity admission", async () => {
    const failure = new Error("prepare failed")
    const capability = defineCapability({
      id: "broken",
      prepare() { throw failure },
    })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      capabilities: [capability],
      driver: { capacity: { concurrency: 1 }, run: () => "unreachable" },
      invocations,
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime("run-1"), {})).rejects.toThrow("prepare failed")
    expect(await invocations.getByRunId("run-1")).toMatchObject({ status: "failed" })
  })

  it("never lets journal storage failures change invocation behavior", async () => {
    const failure = new Error("journal unavailable")
    const store: AgentInvocationStore = {
      claim: () => true,
      create: () => { throw failure },
      get: () => { throw failure },
      getSummary: () => { throw failure },
      getClaimToken: () => { throw failure },
      list: () => { throw failure },
      release: () => { throw failure },
      update: () => { throw failure },
    }
    const agent = defineAgent({
      driver: { run: () => "done" },
      invocations: defineAgentInvocations({ store }),
      runtime: false,
    })

    await expect(runAgent(agent, runtime("run-1"), {})).resolves.toBe("done")
  })

  it("retries the running transition after storage recovers", async () => {
    const memory = createMemoryAgentInvocationStore()
    let runningFailures = 1
    const store: AgentInvocationStore = {
      ...memory,
      update(id, input, claimId) {
        if (input.status === "running" && runningFailures-- > 0) return
        return memory.update(id, input, claimId)
      },
    }
    const waitUntilTasks: Array<Promise<unknown>> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const invocations = defineAgentInvocations({ store })
    const agent = defineAgent({
      driver: { async run() { await gate; return "done" } },
      invocations,
      runtime: false,
    })
    const invocation = runAgent(agent, {
      ...runtime("recover-running"),
      waitUntil: promise => waitUntilTasks.push(promise),
    }, {})

    await vi.waitFor(() => expect(waitUntilTasks).toHaveLength(1))
    await Promise.all(waitUntilTasks)
    await expect(invocations.getByRunId("recover-running")).resolves.toMatchObject({
      startedAt: expect.any(String),
      status: "running",
    })
    release()
    await expect(invocation).resolves.toBe("done")
  })

  it("persists startedAt before a fast terminal transition", async () => {
    const memory = createMemoryAgentInvocationStore()
    let runningFailures = 1
    const recoveryTasks: Array<Promise<unknown>> = []
    const invocations = defineAgentInvocations({
      store: {
        ...memory,
        update(id, input, claimId) {
          if (input.status === "running" && runningFailures-- > 0) return
          return memory.update(id, input, claimId)
        },
      },
    })
    const agent = defineAgent({ driver: { run: () => "done" }, invocations, runtime: false })

    await expect(runAgent(agent, {
      ...runtime("fast-running-recovery"),
      waitUntil: promise => recoveryTasks.push(promise),
    }, {})).resolves.toBe("done")
    await Promise.all(recoveryTasks)
    const record = await invocations.getByRunId("fast-running-recovery")
    expect(record).toMatchObject({
      startedAt: expect.any(String),
      status: "completed",
    })
    expect(record && await memory.claim(record.id, "post-terminal", 30_000)).toBe(true)
  })

  it("normalizes limits while preserving opaque custom-store cursors", async () => {
    const list = vi.fn(() => ({ cursor: "next/token", invocations: [] }))
    const store: AgentInvocationStore = {
      claim: () => true,
      create: input => ({ created: true, record: { ...input, cursor: "created/token" } }),
      get: () => undefined,
      getSummary: () => undefined,
      getClaimToken: () => undefined,
      list,
      release: () => {},
      update: () => undefined,
    }
    const invocations = defineAgentInvocations({ store })

    await expect(invocations.list({ cursor: "opaque/token", limit: 1000, search: "  ViteHub  " })).resolves.toMatchObject({
      cursor: "next/token",
    })
    expect(list).toHaveBeenCalledWith({ cursor: "opaque/token", limit: 100, search: "ViteHub" })
    await expect(invocations.list({ search: "x".repeat(257) })).rejects.toThrow("at most 256 characters")
  })

  it("rejects stores with a missing summary method", () => {
    const store = { ...createMemoryAgentInvocationStore(), getSummary: undefined }

    expect(() => {
      // @ts-expect-error Custom stores must implement metadata reads.
      defineAgentInvocations({ store })
    }).toThrow("getSummary()")
  })

  it("copies memory summaries without cloning observation payloads", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({
      annotations: { project: "original" },
      capabilityIds: ["search"],
      createdAt: timestamp,
      id: "summary-copy",
      observations: [{
        attributes: { "capability.id": "search" },
        name: "tool.result",
        payload: { value: "large observation payload".repeat(1000), visibility: "public" },
        sequence: 1,
        timestamp,
        type: "run",
      }],
      status: "completed",
      traceId: "summary-copy-trace",
      updatedAt: timestamp,
    })
    const clone = vi.spyOn(globalThis, "structuredClone")
    try {
      const summary = await store.getSummary("summary-copy")
      const page = await store.list()
      expect(clone).not.toHaveBeenCalled()
      expect(summary).not.toHaveProperty("observations")
      expect(page.invocations).toEqual([summary])
      expect(summary?.annotations).not.toBe(page.invocations[0]?.annotations)
      expect(summary?.capabilityIds).not.toBe(page.invocations[0]?.capabilityIds)
      summary!.annotations!.project = "changed"
      expect((await store.getSummary("summary-copy"))?.annotations).toEqual({ project: "original" })
      expect((await store.get("summary-copy"))?.observations[0]?.payload).toEqual({
        value: "large observation payload".repeat(1000),
        visibility: "public",
      })
    }
    finally {
      clone.mockRestore()
    }
  })

  it("reads invocation metadata through the store summary method", async () => {
    const memory = createMemoryAgentInvocationStore()
    memory.create({
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "summary-store",
      observations: [{
        name: "private",
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "run",
      }],
      status: "completed",
      traceId: "summary-store-trace",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    const get = vi.spyOn(memory, "get")
    const getSummary = vi.spyOn(memory, "getSummary")
    const invocations = defineAgentInvocations({ store: memory })

    await expect(invocations.getSummary("summary-store")).resolves.toMatchObject({
      id: "summary-store",
      status: "completed",
    })
    await expect(invocations.getSummary("summary-store")).resolves.not.toHaveProperty("observations")
    expect(getSummary).toHaveBeenCalledWith("summary-store")
    expect(get).not.toHaveBeenCalled()
    await expect(invocations.getSummary("missing-invocation")).resolves.toBeUndefined()
  })

  it("keeps terminal records immutable when an invocation id is reused", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const completed = defineAgent({ driver: { run: () => "done" }, invocations, runtime: false })
    const failed = defineAgent({ driver: { run: () => { throw new Error("retry failed") } }, invocations, runtime: false })

    await runAgent(completed, runtime("delivery-1"), {})
    const original = await invocations.getByRunId("delivery-1")
    await expect(runAgent(failed, runtime("delivery-1"), {})).rejects.toThrow("retry failed")
    expect(await invocations.getByRunId("delivery-1")).toEqual(original)
  })

  it("keeps concurrent reuse from sharing one active journal", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({
      driver: {
        async run() {
          calls++
          if (calls === 1) await gate
          return "done"
        },
      },
      invocations,
      runtime: false,
    })

    const first = runAgent(agent, runtime("delivery-1"), {})
    await vi.waitFor(async () => expect((await invocations.getByRunId("delivery-1"))?.status).toBe("running"))
    await expect(runAgent(agent, runtime("delivery-1"), {})).resolves.toBe("done")
    expect((await invocations.getByRunId("delivery-1"))?.status).toBe("running")
    release()
    await expect(first).resolves.toBe("done")
    expect((await invocations.getByRunId("delivery-1"))?.observations.map(event => event.name)).toEqual([
      "vitehub.agent.configured",
      "agent.invocation.start",
      "agent.invocation.finish",
    ])
  })

  it("uses the Agent Definition name when the host has no identity", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ name: "support", driver: { run: () => "done" }, invocations, runtime: false })

    await runAgent(agent, runtime("run-1"), {})

    expect(await invocations.getByRunId("run-1", "support")).toMatchObject({ agentName: "support" })
  })

  it("uses the Agent Definition name instead of a different host identity", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ name: "support", driver: { run: () => "done" }, invocations, runtime: false })

    await runAgent(agent, { ...runtime("aliased-run"), agentIdentity: { name: "host-alias" } }, {})

    await expect(invocations.getByRunId("aliased-run", "support")).resolves.toMatchObject({ agentName: "support" })
    await expect(invocations.getByRunId("aliased-run", "host-alias")).resolves.toBeUndefined()
  })

  it("isolates matching source run IDs by Agent Definition", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const support = defineAgent({ name: "support", driver: { run: () => "support" }, invocations, runtime: false })
    const review = defineAgent({ name: "review", driver: { run: () => "review" }, invocations, runtime: false })

    await Promise.all([
      runAgent(support, runtime("shared-run"), {}),
      runAgent(review, runtime("shared-run"), {}),
    ])

    await expect(invocations.getByRunId("shared-run", "support")).resolves.toMatchObject({ agentName: "support" })
    await expect(invocations.getByRunId("shared-run", "review")).resolves.toMatchObject({ agentName: "review" })
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [{}, {}] })
  })

  it("resolves the public invocation ID from a run and Agent Definition", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ name: "support", driver: { run: () => "done" }, invocations, runtime: false })

    await runAgent(agent, runtime("linked-run"), {})

    const id = await agentInvocationId("linked-run", "support")
    await expect(invocations.get(id)).resolves.toMatchObject({ agentName: "support" })
    await expect(agentInvocationId("linked-run", "review")).resolves.not.toBe(id)
  })

  it("encodes Agent Definition and run identities without delimiter collisions", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const first = defineAgent({ name: "a\0b", driver: { run: () => "first" }, invocations, runtime: false })
    const second = defineAgent({ name: "a", driver: { run: () => "second" }, invocations, runtime: false })

    await Promise.all([
      runAgent(first, runtime("c"), {}),
      runAgent(second, runtime("b\0c"), {}),
    ])

    await expect(invocations.getByRunId("c", "a\0b")).resolves.toMatchObject({ agentName: "a\0b" })
    await expect(invocations.getByRunId("b\0c", "a")).resolves.toMatchObject({ agentName: "a" })
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [{}, {}] })
  })

  it("bounds dynamic summary metadata without truncating invocation identity", async () => {
    const oversized = "x".repeat(700)
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: () => { throw new Error(oversized) } }, invocations, runtime: false })
    const context = {
      ...runtime(oversized),
      run: { channelId: oversized, origin: oversized, runId: oversized, threadId: oversized },
    }

    await expect(runAgent(agent, context, {})).rejects.toThrow(oversized)
    const record = await invocations.getByRunId(oversized)
    expect(record?.id).toMatch(/^sha256_[\da-f]{64}$/)
    expect(record?.channelId).toHaveLength(512)
    expect(record?.origin).toHaveLength(512)
    expect(record?.threadId).toHaveLength(512)
    expect(record?.error?.message).toHaveLength(512)
    const errorObservation = record?.observations.find(observation => observation.type === "error")
    expect(errorObservation?.attributes?.["error.message"]).toHaveLength(512)
  })

  it("preserves bounded causes and AggregateError children in durable failures", async () => {
    const checkout = Object.assign(new Error("Checkout failed", {
      cause: Object.assign(new Error("Git authentication failed"), { code: "EAUTH" }),
    }), { status: 128 })
    const restore = new Error("Excluded state restoration failed")
    const failure = new AggregateError([checkout, restore], "Workspace Session setup and restoration failed")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: () => { throw failure } }, invocations, runtime: false })

    await expect(runAgent(agent, runtime("aggregate-failure"), {})).rejects.toBe(failure)

    expect((await invocations.getByRunId("aggregate-failure"))?.error).toEqual({
      errors: [{
        cause: {
          code: "EAUTH",
          message: "Git authentication failed",
          name: "Error",
        },
        message: "Checkout failed",
        name: "Error",
        status: 128,
      }, {
        message: "Excluded state restoration failed",
        name: "Error",
      }],
      message: "Workspace Session setup and restoration failed",
      name: "AggregateError",
    })
  })

  it("keeps digest-shaped and oversized source ids independently inspectable", async () => {
    const oversized = "x".repeat(700)
    const oversizedDigest = `sha256_${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(oversized)))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("")}`
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: { run: ({ input }) => input.prompt }, invocations, runtime: false })

    await runAgent(agent, runtime(oversized), { prompt: "oversized" })
    await runAgent(agent, runtime(oversizedDigest), { prompt: "digest-shaped" })
    const listed = await invocations.list()
    expect(listed.invocations).toHaveLength(2)
    expect(new Set(listed.invocations.map(invocation => invocation.id)).size).toBe(2)
    await expect(Promise.all(listed.invocations.map(invocation => invocations.get(invocation.id))))
      .resolves.toEqual(expect.arrayContaining(listed.invocations.map(invocation => expect.objectContaining({ id: invocation.id }))))
    await expect(invocations.getByRunId(oversized)).resolves.toMatchObject({ id: listed.invocations[1]!.id })
    await expect(invocations.getByRunId(oversizedDigest)).resolves.toMatchObject({ id: listed.invocations[0]!.id })
  })

  it("persists records through the libSQL SQLite adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-"))
    const url = `file:${join(directory, "invocations.sqlite")}`
    const writerClient = createClient({ url })
    const readerClient = createClient({ url })
    try {
      const invocations = defineAgentInvocations({
        store: createLibsqlAgentInvocationStore({ client: writerClient }),
      })
      await expect(invocations.list({ status: [] })).resolves.toEqual({ invocations: [] })
      const agent = defineAgent({
        driver: { async run(context) {
          await context.traceLog?.append({ attributes: { nan: Number.NaN }, name: "numbers", type: "run" })
          await context.traceLog?.append({
            name: "negative-zero",
            payload: { value: -0, visibility: "public" },
            type: "run",
          })
          return "persisted"
        } },
        invocations,
        runtime: false,
      })
      await runAgent(agent, runtime("durable-run", { "github.repository": "vite-hub/vitehub" }), {})
      await runAgent(agent, runtime("unicode-search", { "github.repository": "Éclair" }), {})
      await runAgent(
        defineAgent({
          driver: { run: () => "reviewed" },
          invocations,
          name: "review",
          runtime: false,
        }),
        runtime("named-review"),
        {},
      )

      const restored = defineAgentInvocations({
        store: createLibsqlAgentInvocationStore({ client: readerClient }),
      })
      expect(await restored.getByRunId("durable-run")).toMatchObject({
        id: expect.stringMatching(/^sha256_[\da-f]{64}$/),
        status: "completed",
      })
      expect((await restored.getByRunId("durable-run"))?.observations.map(event => event.name)).toEqual([
        "vitehub.agent.configured",
        "agent.invocation.start",
        "numbers",
        "negative-zero",
        "agent.invocation.finish",
      ])
      expect((await restored.getByRunId("durable-run"))?.observations[2]?.attributes).toMatchObject({ nan: null })
      expect((await restored.getByRunId("durable-run"))?.observations[3]).toMatchObject({
        attributes: { "vitehub.observation.truncated": true },
        payload: { value: 0, visibility: "public" },
      })
      await expect(restored.list({ search: "VITE-HUB/VITEHUB" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ status: "completed" })],
      })
      await expect(restored.list({ search: "éclair" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ status: "completed" })],
      })
      await expect(restored.list({ agentName: "review" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ agentName: "review" })],
      })
      await expect(restored.list({ agentName: "review-assistant" })).resolves.toEqual({
        invocations: [],
      })
      const agentQueryPlan = await readerClient.execute({
        args: ["review"],
        sql: "EXPLAIN QUERY PLAN SELECT sequence, record FROM vitehub_agent_invocations WHERE agent_name = ? ORDER BY sequence DESC LIMIT 51",
      })
      expect(agentQueryPlan.rows.map(row => String(row.detail))).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_agent_name_sequence"),
      )
      const compatibleAgentQueryPlan = await readerClient.execute({
        args: ["review", "review"],
        sql: `EXPLAIN QUERY PLAN SELECT sequence, record FROM vitehub_agent_invocations
          WHERE agent_name = ? OR ((agent_name IS NULL OR agent_name = '') AND json_extract(record, '$.agentName') = ?)
          ORDER BY sequence DESC LIMIT 51`,
      })
      const compatibleAgentPlanDetails = compatibleAgentQueryPlan.rows.map(row => String(row.detail))
      expect(compatibleAgentPlanDetails).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_agent_name_sequence"),
      )
      expect(compatibleAgentPlanDetails).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_legacy_agent_name_sequence"),
      )
      const localeLowercase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
        return String(this).replaceAll("I", "ı").toLowerCase()
      })
      try {
        await runAgent(agent, runtime("locale-search", { "github.repository": "INDIGO" }), {})
        await expect(restored.list({ search: "indigo" })).resolves.toMatchObject({
          invocations: [expect.objectContaining({ status: "completed" })],
        })
      }
      finally {
        localeLowercase.mockRestore()
      }
      await expect(restored.list({ search: "missing repository" })).resolves.toEqual({ invocations: [] })
      for (const cursor of ["invalid", "01", "1.0", " 1", String(Number.MAX_SAFE_INTEGER + 1)]) {
        await expect(restored.list({ cursor })).rejects.toThrow("cursor is invalid")
      }
    }
    finally {
      writerClient.close()
      readerClient.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("stores a compact searchable SQLite projection without raw tool payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-search-projection-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    const timestamp = "2026-01-01T00:00:00.000Z"
    const bulkyToolPayload = `raw-tool-payload-${"x".repeat(512 * 1024)}`
    try {
      await store.create({
        agentName: "babysitter",
        annotations: { "github.repository": "vite-hub/vitehub" },
        createdAt: timestamp,
        id: "compact-search",
        observations: [{
          attributes: {
            "input.messages": [{ content: "Investigate the slow session picker", role: "user" }],
            "message.content": "The selected session now opens quickly.",
            "tool.name": "shell",
            "tool.output": { content: bulkyToolPayload },
            "vitehub.activity.body": bulkyToolPayload,
          },
          name: "agent.message",
          sequence: 1,
          timestamp,
          type: "run",
        }],
        status: "completed",
        traceId: "compact-search-trace",
        updatedAt: timestamp,
      })

      await expect(store.list({ search: "selected session now opens" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "compact-search" })],
      })
      await expect(store.list({ search: "slow session picker" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "compact-search" })],
      })
      await expect(store.list({ search: "raw-tool-payload" })).resolves.toEqual({ invocations: [] })
      await expect(store.list({ search: "vite-hub/vitehub" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "compact-search" })],
      })
      const indexed = await client.execute(`SELECT length(record) AS record_bytes,
        length(search) AS search_bytes, search, search_version
        FROM vitehub_agent_invocations WHERE id = 'compact-search'`)
      expect(Number(indexed.rows[0]?.search_version)).toBe(3)
      expect(Number(indexed.rows[0]?.search_bytes)).toBeLessThan(Number(indexed.rows[0]?.record_bytes) / 100)
      expect(String(indexed.rows[0]?.search)).not.toContain("raw-tool-payload")
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("persists compact SQLite invocation summaries apart from observation records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-summary-projection-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    const timestamp = "2026-01-01T00:00:00.000Z"
    try {
      await store.create({
        agentName: "babysitter",
        createdAt: timestamp,
        id: "compact-summary",
        observations: [{
          attributes: { payload: "x".repeat(512 * 1024) },
          name: "large-observation",
          sequence: 1,
          timestamp,
          type: "run",
        }],
        status: "running",
        traceId: "compact-summary-trace",
        updatedAt: timestamp,
      })

      const stored = await client.execute(`SELECT length(record) AS record_bytes,
        length(summary) AS summary_bytes, summary
        FROM vitehub_agent_invocations WHERE id = 'compact-summary'`)
      expect(Number(stored.rows[0]?.summary_bytes)).toBeLessThan(Number(stored.rows[0]?.record_bytes) / 100)
      expect(JSON.parse(String(stored.rows[0]?.summary))).toMatchObject({
        id: "compact-summary",
        status: "running",
      })
      expect(JSON.parse(String(stored.rows[0]?.summary))).not.toHaveProperty("observations")
      await expect(store.getSummary("compact-summary")).resolves.toMatchObject({
        id: "compact-summary",
        status: "running",
      })
      await expect(store.getSummary("compact-summary")).resolves.not.toHaveProperty("observations")

      await store.update("compact-summary", {
        status: "completed",
        timestamp: "2026-01-01T00:01:00.000Z",
      })
      const updated = await client.execute(
        "SELECT summary FROM vitehub_agent_invocations WHERE id = 'compact-summary'",
      )
      expect(JSON.parse(String(updated.rows[0]?.summary))).toMatchObject({
        completedAt: "2026-01-01T00:01:00.000Z",
        status: "completed",
        updatedAt: "2026-01-01T00:01:00.000Z",
      })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rebuilds version-two SQLite search rows with the compact projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-search-v3-migration-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const timestamp = "2026-01-01T00:00:00.000Z"
    const bulkyToolPayload = `legacy-tool-payload-${"x".repeat(256 * 1024)}`
    const record = {
      agentName: "review",
      createdAt: timestamp,
      id: "legacy-search-v2",
      observations: [{
        attributes: {
          "message.content": "Legacy searchable message",
          "tool.output": bulkyToolPayload,
        },
        name: "agent.message",
        sequence: 1,
        timestamp,
        type: "run",
      }],
      status: "completed",
      traceId: "legacy-search-v2-trace",
      updatedAt: timestamp,
    }
    try {
      await client.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
      )`)
      await client.execute({
        args: [record.id, record.status, record.agentName, JSON.stringify(record).toLowerCase(), 2, timestamp, JSON.stringify(record)],
        sql: `INSERT INTO vitehub_agent_invocations
          (id, status, agent_name, search, search_version, updated_at, record)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      })

      const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
      await expect(store.list({ search: "legacy searchable message" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "legacy-search-v2" })],
      })
      await expect(store.list({ search: "legacy-tool-payload" })).resolves.toEqual({ invocations: [] })
      const migrated = await client.execute(`SELECT length(record) AS record_bytes,
        length(search) AS search_bytes, search_version
        FROM vitehub_agent_invocations WHERE id = 'legacy-search-v2'`)
      expect(Number(migrated.rows[0]?.search_version)).toBe(3)
      expect(Number(migrated.rows[0]?.search_bytes)).toBeLessThan(Number(migrated.rows[0]?.record_bytes) / 100)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("omits SQLite observation payloads before reading list rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-summaries-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    let listedRecord: unknown
    let listedSummary: unknown
    // SAFETY: the proxy forwards every Client member and only observes the list query result.
    const observingClient = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== "execute") return value instanceof Function ? value.bind(target) : value
        return async (...args: unknown[]) => {
          // SAFETY: the proxy receives the arguments of Client.execute and forwards them unchanged.
          const result = await (client.execute as (...executeArgs: unknown[]) => Promise<{ rows: Array<{ record?: unknown, summary?: unknown }> }>)(...args)
          // SAFETY: Client.execute accepts a SQL string or a statement whose sql member is the SQL string.
          const statement = String((args[0] as { sql?: unknown } | undefined)?.sql ?? args[0] ?? "")
          if (statement.includes("ORDER BY sequence DESC LIMIT ?")) {
            listedRecord = result.rows[0]?.record
            listedSummary = result.rows[0]?.summary
          }
          return result
        }
      },
    }) as Client
    const store = createLibsqlAgentInvocationStore({ client: observingClient, maxAgeMs: false, maxRecords: false })
    const timestamp = "2026-01-01T00:00:00.000Z"
    try {
      await store.create({
        createdAt: timestamp,
        id: "bounded-summary",
        observations: [{
          attributes: { payload: "x".repeat(64 * 1024) },
          name: "large-observation",
          sequence: 0,
          timestamp,
          type: "run",
        }],
        status: "completed",
        traceId: "trace",
        updatedAt: timestamp,
      })

      await expect(store.list()).resolves.toMatchObject({
        invocations: [expect.not.objectContaining({ observations: expect.anything() })],
      })
      expect(listedRecord).toBeUndefined()
      expect(listedSummary).toEqual(expect.any(String))
      expect(JSON.parse(String(listedSummary))).not.toHaveProperty("observations")
      await expect(store.get("bounded-summary")).resolves.toMatchObject({
        observations: [expect.objectContaining({ name: "large-observation" })],
      })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("serializes concurrent writes through one SQLite invocation store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-concurrent-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client })
    const createdAt = new Date().toISOString()
    const ids = Array.from({ length: 12 }, (_, index) => `invocation-${index}`)
    try {
      await Promise.all(ids.map(id => store.create({
        createdAt,
        id,
        observations: [],
        status: "pending",
        traceId: id,
        updatedAt: createdAt,
      })))
      await Promise.all(ids.map(id => store.update(id, { status: "completed", timestamp: createdAt })))

      const records = await Promise.all(ids.map(id => store.get(id)))
      expect(records.every(record => record?.status === "completed")).toBe(true)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("bounds terminal SQLite invocation records by age and count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-retention-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const unboundedStore = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: 1_000, maxRecords: 2 })
    const recent = new Date().toISOString()
    const expired = new Date(Date.now() - 2_000).toISOString()
    const record = (id: string, status: "completed" | "running", updatedAt = recent) => ({
      createdAt: updatedAt,
      id,
      observations: [],
      status,
      traceId: `${id}-trace`,
      updatedAt,
    })
    try {
      await unboundedStore.create(record("expired", "completed", expired))
      await store.create(record("active", "running", expired))
      await store.create(record("first", "completed"))
      await expect(store.claim("first", "first-claim", 30_000)).resolves.toBe(true)
      await store.create(record("second", "completed"))
      await store.create(record("third", "completed"))

      await expect(store.get("expired")).resolves.toBeUndefined()
      await expect(store.get("first")).resolves.toBeUndefined()
      await expect(store.get("active")).resolves.toMatchObject({ status: "running" })
      await expect(store.list({ limit: 10 })).resolves.toMatchObject({
        invocations: [
          expect.objectContaining({ id: "third" }),
          expect.objectContaining({ id: "second" }),
          expect.objectContaining({ id: "active" }),
        ],
      })
      const orphanedClaims = await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations_claims")
      expect(Number(orphanedClaims.rows[0]?.count)).toBe(0)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("prunes SQLite retention when an invocation becomes terminal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-terminal-retention-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: 1 })
    const timestamp = new Date().toISOString()
    const pending = (id: string) => ({
      createdAt: timestamp,
      id,
      observations: [],
      status: "pending" as const,
      traceId: `${id}-trace`,
      updatedAt: timestamp,
    })
    try {
      await store.create(pending("first"))
      await store.update("first", { status: "completed", timestamp })
      await store.create(pending("second"))
      await store.update("second", { status: "completed", timestamp })

      await expect(store.get("first")).resolves.toBeUndefined()
      await expect(store.get("second")).resolves.toMatchObject({ status: "completed" })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("recreates a duplicate SQLite invocation when retention prunes the old record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-duplicate-retention-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const unboundedStore = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: 1_000, maxRecords: false })
    const expired = new Date(Date.now() - 2_000).toISOString()
    const current = new Date().toISOString()
    try {
      await unboundedStore.create({
        createdAt: expired,
        id: "retry",
        observations: [],
        status: "completed",
        traceId: "old-trace",
        updatedAt: expired,
      })

      await expect(store.create({
        createdAt: current,
        id: "retry",
        observations: [],
        status: "pending",
        traceId: "new-trace",
        updatedAt: current,
      })).resolves.toMatchObject({
        created: true,
        record: { id: "retry", status: "pending", traceId: "new-trace" },
      })
      await expect(store.get("retry")).resolves.toMatchObject({ status: "pending", traceId: "new-trace" })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("returns the current SQLite invocation when stores concurrently recreate a pruned duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-concurrent-duplicate-retention-"))
    const clients = [
      createClient({ url: `file:${join(directory, "invocations.sqlite")}` }),
      createClient({ url: `file:${join(directory, "invocations.sqlite")}` }),
    ]
    const unboundedStore = createLibsqlAgentInvocationStore({ client: clients[0], maxAgeMs: false, maxRecords: false })
    const stores = clients.map(client => createLibsqlAgentInvocationStore({ client, maxAgeMs: 1_000, maxRecords: false }))
    const expired = new Date(Date.now() - 2_000).toISOString()
    const current = new Date().toISOString()
    try {
      await unboundedStore.create({
        createdAt: expired,
        id: "retry",
        observations: [],
        status: "completed",
        traceId: "old-trace",
        updatedAt: expired,
      })

      const results = await Promise.all(stores.map((store, index) => store.create({
        createdAt: current,
        id: "retry",
        observations: [],
        status: "pending",
        traceId: `new-trace-${index}`,
        updatedAt: current,
      })))

      expect(results.filter(result => result.created)).toHaveLength(1)
      expect(results[0]!.record).toEqual(results[1]!.record)
      await expect(stores[0]!.get("retry")).resolves.toEqual(results[0]!.record)
    }
    finally {
      clients.forEach(client => client.close())
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("prunes a recreated terminal SQLite duplicate before create returns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-terminal-duplicate-retention-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const unboundedStore = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: 1 })
    const timestamp = new Date().toISOString()
    const terminal = (id: string, traceId = `${id}-trace`) => ({
      createdAt: timestamp,
      id,
      observations: [],
      status: "completed" as const,
      traceId,
      updatedAt: timestamp,
    })
    try {
      await unboundedStore.create(terminal("retry", "old-trace"))
      await unboundedStore.create(terminal("newer"))

      await expect(store.create(terminal("retry", "replacement-trace"))).resolves.toMatchObject({
        created: true,
        record: { id: "retry", traceId: "replacement-trace" },
      })
      await expect(store.list({ limit: 10 })).resolves.toMatchObject({ invocations: [{ id: "retry" }] })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("uses one age cutoff while creating a terminal SQLite duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-terminal-duplicate-cutoff-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const unboundedStore = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: 1_000, maxRecords: false })
    const now = Date.now()
    const nearlyExpired = new Date(now - 999).toISOString()
    try {
      await unboundedStore.create({
        createdAt: nearlyExpired,
        id: "retry",
        observations: [],
        status: "completed",
        traceId: "old-trace",
        updatedAt: nearlyExpired,
      })
      const clock = vi.spyOn(Date, "now")
        .mockReturnValueOnce(now)
        .mockReturnValue(now + 2)

      await expect(store.create({
        createdAt: new Date(now).toISOString(),
        id: "retry",
        observations: [],
        status: "completed",
        traceId: "replacement-trace",
        updatedAt: new Date(now).toISOString(),
      })).resolves.toMatchObject({
        created: false,
        record: { id: "retry", traceId: "old-trace" },
      })
      clock.mockRestore()
      await expect(store.get("retry")).resolves.toMatchObject({ traceId: "old-trace" })
    }
    finally {
      vi.restoreAllMocks()
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects an age-expired terminal SQLite create that retention removes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-expired-create-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: 1_000, maxRecords: false })
    const expired = new Date(Date.now() - 2_000).toISOString()
    try {
      await expect(store.create({
        createdAt: expired,
        id: "expired",
        observations: [],
        status: "completed",
        traceId: "expired-trace",
        updatedAt: expired,
      })).rejects.toThrow("removed by retention")
      await expect(store.get("expired")).resolves.toBeUndefined()
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("validates and disables SQLite invocation retention limits", async () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      // SAFETY: invalid retention options throw before the client is accessed.
      expect(() => createLibsqlAgentInvocationStore({ client: {} as Client, maxAgeMs: value })).toThrow("maxAgeMs")
      // SAFETY: invalid retention options throw before the client is accessed.
      expect(() => createLibsqlAgentInvocationStore({ client: {} as Client, maxRecords: value })).toThrow("maxRecords")
    }
    // SAFETY: invalid retention options throw before the client is accessed.
    expect(() => createLibsqlAgentInvocationStore({ client: {} as Client, maxAgeMs: Number.MAX_SAFE_INTEGER })).toThrow("maxAgeMs")
    // SAFETY: constructing the store does not access the client.
    expect(() => createLibsqlAgentInvocationStore({ client: {} as Client, maxRecords: Number.MAX_SAFE_INTEGER })).not.toThrow()

    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-unbounded-retention-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    try {
      const expired = "2020-01-01T00:00:00.000Z"
      for (const id of ["first", "second", "third"]) {
        await store.create({ createdAt: expired, id, observations: [], status: "completed", traceId: `${id}-trace`, updatedAt: expired })
      }
      await expect(store.list({ limit: 10 })).resolves.toMatchObject({ invocations: [{ id: "third" }, { id: "second" }, { id: "first" }] })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("initializes the libSQL search index concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-migration-"))
    const url = `file:${join(directory, "invocations.sqlite")}`
    const setupClient = createClient({ url })
    const firstClient = createClient({ url })
    const secondClient = createClient({ url })
    try {
      await setupClient.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        updated_at TEXT,
        record TEXT NOT NULL
      )`)
      await setupClient.execute(`CREATE TRIGGER vitehub_agent_invocations_legacy_updated_at_update
        AFTER UPDATE OF record ON vitehub_agent_invocations
        WHEN NEW.updated_at IS OLD.updated_at
        BEGIN
          UPDATE vitehub_agent_invocations
          SET updated_at = COALESCE(json_extract(NEW.record, '$.updatedAt'), '')
          WHERE sequence = NEW.sequence;
        END`)
      await setupClient.execute(`CREATE TABLE vitehub_agent_invocations_claims (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`)
      await setupClient.execute({
        args: [JSON.stringify({
          agentName: "review",
          annotations: { repository: "Éclair" },
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "legacy",
          observations: [{ attributes: { secret: "observation-only" }, name: "legacy", timestamp: "2026-01-01T00:00:00.000Z", type: "run" }],
          status: "completed",
          traceId: "legacy-trace",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES ('legacy', 'running', ?)",
      })
      await setupClient.execute(`INSERT INTO vitehub_agent_invocations_claims (id, claim_id, expires_at)
        VALUES ('legacy', 'legacy-worker', 2000000000000)`)

      let inspections = 0
      let releaseInspections!: () => void
      const inspectionsComplete = new Promise<void>((resolve) => {
        releaseInspections = resolve
      })
      // SAFETY: the proxy forwards every Client member and only wraps execute with the same call contract.
      const synchronizeInspection = (client: Client): Client => new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property !== "execute") return value instanceof Function ? value.bind(target) : value
          return async (...args: unknown[]) => {
            // SAFETY: the proxy receives the arguments of Client.execute and forwards them unchanged.
            const result = await (client.execute as (...executeArgs: unknown[]) => Promise<unknown>)(...args)
            const statement = Object.prototype.toString.call(args[0]) === "[object String]" ? String(args[0]) : undefined
            if (statement?.startsWith("PRAGMA table_info") && inspections < 2) {
              inspections++
              if (inspections === 2) releaseInspections()
              await inspectionsComplete
            }
            return result
          }
        },
      }) as Client

      await expect(Promise.all([
        createLibsqlAgentInvocationStore({ client: synchronizeInspection(firstClient) }).list({ search: "éclair" }),
        createLibsqlAgentInvocationStore({ client: synchronizeInspection(secondClient) }).list({ search: "éclair" }),
      ])).resolves.toEqual([
        { invocations: [expect.objectContaining({ id: "legacy" })] },
        { invocations: [expect.objectContaining({ id: "legacy" })] },
      ])
      const migratedAgent = await firstClient.execute("SELECT agent_name, status, updated_at FROM vitehub_agent_invocations WHERE id = 'legacy'")
      expect(migratedAgent.rows[0]?.agent_name).toBe("review")
      expect(migratedAgent.rows[0]?.status).toBe("completed")
      expect(migratedAgent.rows[0]?.updated_at).toBe("2026-01-01T00:00:00.000Z")
      await vi.waitFor(async () => {
        const migratedSummary = await firstClient.execute(
          "SELECT summary FROM vitehub_agent_invocations WHERE id = 'legacy'",
        )
        expect(migratedSummary.rows[0]?.summary).toEqual(expect.any(String))
        expect(JSON.parse(String(migratedSummary.rows[0]?.summary))).not.toHaveProperty("observations")
      })
      const migratedUpdateTrigger = await firstClient.execute(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'trigger'
          AND name IN ('vitehub_agent_invocations_legacy_updated_at_update', 'vitehub_agent_invocations_legacy_lifecycle_update_v2')`,
      )
      expect(migratedUpdateTrigger.rows).toHaveLength(1)
      expect(migratedUpdateTrigger.rows[0]?.name).toBe("vitehub_agent_invocations_legacy_lifecycle_update_v2")
      expect(migratedUpdateTrigger.rows[0]?.sql).toContain("status = COALESCE")
      const migratedClaim = await firstClient.execute(`SELECT claimed_at, claim_token
        FROM vitehub_agent_invocations_claims WHERE id = 'legacy'`)
      expect(Number(migratedClaim.rows[0]?.claimed_at)).toBeGreaterThan(0)
      expect(migratedClaim.rows[0]?.claim_token).toBe("")
      await setupClient.execute(`UPDATE vitehub_agent_invocations_claims
        SET expires_at = 2000000001000 WHERE id = 'legacy'`)
      const renewedClaim = await firstClient.execute(`SELECT claimed_at, claim_token
        FROM vitehub_agent_invocations_claims WHERE id = 'legacy'`)
      expect(Number(renewedClaim.rows[0]?.claimed_at)).toBeGreaterThanOrEqual(Number(migratedClaim.rows[0]?.claimed_at))
      expect(renewedClaim.rows[0]?.claim_token).not.toBe("")
      await expect(createLibsqlAgentInvocationStore({ client: firstClient }).list({ search: "observation-only" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "legacy" })] })
      await expect(createLibsqlAgentInvocationStore({ client: firstClient }).list({ agentName: "review" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "legacy" })] })
      const initializedStore = createLibsqlAgentInvocationStore({ client: firstClient })
      await initializedStore.list()
      await setupClient.execute({
        args: [JSON.stringify({
          agentName: "review",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "overlapping-legacy-writer",
          observations: [],
          status: "completed",
          traceId: "overlapping-legacy-trace",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES ('overlapping-legacy-writer', 'completed', ?)",
      })
      const overlappingInsert = await setupClient.execute(
        "SELECT summary, updated_at FROM vitehub_agent_invocations WHERE id = 'overlapping-legacy-writer'",
      )
      expect(overlappingInsert.rows[0]?.updated_at).toBe("2026-01-01T00:00:00.000Z")
      expect(JSON.parse(String(overlappingInsert.rows[0]?.summary))).toMatchObject({
        id: "overlapping-legacy-writer",
        status: "completed",
      })
      expect(JSON.parse(String(overlappingInsert.rows[0]?.summary))).not.toHaveProperty("observations")
      await expect(initializedStore.list({ agentName: "review" })).resolves.toMatchObject({
        invocations: expect.arrayContaining([expect.objectContaining({ id: "overlapping-legacy-writer" })]),
      })
      const completedMigrationPlan = await firstClient.execute(`EXPLAIN QUERY PLAN
        SELECT sequence FROM vitehub_agent_invocations
        WHERE (updated_at = '' OR updated_at IS NULL) AND sequence > 0 ORDER BY sequence LIMIT 100`)
      expect(completedMigrationPlan.rows.map(row => row.detail)).toContainEqual(
        expect.stringContaining("vitehub_agent_invocations_missing_updated_at_sequence"),
      )
    }
    finally {
      setupClient.close()
      firstClient.close()
      secondClient.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("keeps ordinary libSQL reads available while compact search backfills", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-background-search-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    let releaseBackfill: (() => void) | undefined
    try {
      await client.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
      )`)
      const timestamp = "2026-01-01T00:00:00.000Z"
      const record = {
        agentName: "review",
        createdAt: timestamp,
        id: "legacy-search-v2",
        observations: [{
          attributes: { "message.content": "Legacy searchable message" },
          name: "agent.message",
          sequence: 1,
          timestamp,
          type: "run",
        }],
        status: "completed",
        traceId: "legacy-search-v2-trace",
        updatedAt: timestamp,
      }
      await client.execute({
        args: [record.id, record.status, record.agentName, JSON.stringify(record).toLowerCase(), 2, timestamp, JSON.stringify(record)],
        sql: `INSERT INTO vitehub_agent_invocations
          (id, status, agent_name, search, search_version, updated_at, record)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      })

      let markBackfillStarted!: () => void
      const backfillStarted = new Promise<void>((resolve) => {
        markBackfillStarted = resolve
      })
      const backfillReleased = new Promise<void>((resolve) => {
        releaseBackfill = resolve
      })
      // SAFETY: The proxy forwards every Client member and only pauses the v3 search-backfill query.
      const stalledClient = new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property !== "execute") return value instanceof Function ? value.bind(target) : value
          return async (...args: unknown[]) => {
            const input = args[0]
            const sql = input !== null && hasRuntimeType(input, "object") && "sql" in input && hasRuntimeType(input.sql, "string")
              ? input.sql
              : ""
            if (sql.includes("search_version < ?")) {
              markBackfillStarted()
              await backfillReleased
            }
            // SAFETY: The proxy receives Client.execute arguments and forwards them unchanged.
            return await (client.execute as (...executeArgs: unknown[]) => Promise<unknown>)(...args)
          }
        },
      }) as Client
      const store = createLibsqlAgentInvocationStore({ client: stalledClient, maxAgeMs: false, maxRecords: false })
      const ordinaryReads = Promise.all([
        store.get("legacy-search-v2"),
        store.list(),
        store.listAgentNames!(),
      ])

      await backfillStarted
      await expect(ordinaryReads).resolves.toEqual([
        expect.objectContaining({ id: "legacy-search-v2" }),
        { invocations: [expect.objectContaining({ id: "legacy-search-v2" })] },
        ["review"],
      ])
      let searchSettled = false
      const search = Promise.resolve(store.list({ search: "legacy searchable message" }))
      void search.then(() => {
        searchSettled = true
      }, () => {
        searchSettled = true
      })
      await Promise.resolve()
      expect(searchSettled).toBe(false)

      releaseBackfill?.()
      await expect(search).resolves.toEqual({
        invocations: [expect.objectContaining({ id: "legacy-search-v2" })],
      })
    }
    finally {
      releaseBackfill?.()
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("keeps legacy reads available while compact invocation summaries backfill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-background-summary-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    let releaseBackfill: (() => void) | undefined
    try {
      await client.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
      )`)
      const timestamp = "2026-01-01T00:00:00.000Z"
      const record = {
        agentName: "review",
        createdAt: timestamp,
        id: "legacy-summary",
        observations: [{
          attributes: { payload: "x".repeat(64 * 1024) },
          name: "legacy",
          sequence: 1,
          timestamp,
          type: "run",
        }],
        status: "completed",
        traceId: "legacy-summary-trace",
        updatedAt: timestamp,
      }
      await client.execute({
        args: [record.id, record.status, record.agentName, "review", 3, timestamp, JSON.stringify(record)],
        sql: `INSERT INTO vitehub_agent_invocations
          (id, status, agent_name, search, search_version, updated_at, record)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      })

      let markBackfillStarted!: () => void
      const backfillStarted = new Promise<void>((resolve) => {
        markBackfillStarted = resolve
      })
      const backfillReleased = new Promise<void>((resolve) => {
        releaseBackfill = resolve
      })
      let summaryBackfillQueries = 0
      // SAFETY: The proxy forwards every Client member and only pauses the summary-backfill query.
      const stalledClient = new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property !== "execute") return value instanceof Function ? value.bind(target) : value
          return async (...args: unknown[]) => {
            const input = args[0]
            const sql = input !== null && hasRuntimeType(input, "object") && "sql" in input && hasRuntimeType(input.sql, "string")
              ? input.sql
              : ""
            if (sql.includes("WHERE summary IS NULL") && sql.includes("ORDER BY sequence DESC")) {
              summaryBackfillQueries++
              markBackfillStarted()
              await backfillReleased
            }
            // SAFETY: The proxy receives Client.execute arguments and forwards them unchanged.
            return await (client.execute as (...executeArgs: unknown[]) => Promise<unknown>)(...args)
          }
        },
      }) as Client
      const store = createLibsqlAgentInvocationStore({ client: stalledClient, maxAgeMs: false, maxRecords: false })
      const ordinaryReads = Promise.all([
        store.get("legacy-summary"),
        store.getSummary("legacy-summary"),
        store.list(),
      ])

      await backfillStarted
      await expect(ordinaryReads).resolves.toEqual([
        expect.objectContaining({ id: "legacy-summary", observations: [expect.anything()] }),
        expect.not.objectContaining({ observations: expect.anything() }),
        { invocations: [expect.not.objectContaining({ observations: expect.anything() })] },
      ])

      releaseBackfill?.()
      await vi.waitFor(async () => {
        const persisted = await client.execute(
          "SELECT summary FROM vitehub_agent_invocations WHERE id = 'legacy-summary'",
        )
        expect(persisted.rows[0]?.summary).toEqual(expect.any(String))
        expect(summaryBackfillQueries).toBe(2)
      })
      await store.list()
      await store.getSummary("legacy-summary")
      expect(summaryBackfillQueries).toBe(2)
    }
    finally {
      releaseBackfill?.()
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("retries failed invocation summary backfills on later summary reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-summary-retry-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    let failFirstBackfill = (): void => {}
    try {
      await client.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        search TEXT,
        search_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT '',
        record TEXT NOT NULL
      )`)
      const timestamp = "2026-01-01T00:00:00.000Z"
      const record = {
        agentName: "review",
        createdAt: timestamp,
        id: "legacy-summary-retry",
        observations: [{ name: "legacy", timestamp, type: "run" }],
        status: "completed",
        traceId: "legacy-summary-retry-trace",
        updatedAt: timestamp,
      }
      await client.execute({
        args: [record.id, record.status, record.agentName, "review", 3, timestamp, JSON.stringify(record)],
        sql: `INSERT INTO vitehub_agent_invocations
          (id, status, agent_name, search, search_version, updated_at, record)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      })

      let summaryBackfillAttempts = 0
      const firstBackfillFailure = new Promise<never>((_resolve, reject) => {
        failFirstBackfill = () => reject(new Error("temporarily unavailable"))
      })
      // SAFETY: The proxy forwards every Client member and fails only the first summary-backfill batch.
      const transientClient = new Proxy(client, {
        get(target, property) {
          const value = Reflect.get(target, property)
          if (property !== "batch") return value instanceof Function ? value.bind(target) : value
          return async (...args: unknown[]) => {
            const statements = Array.isArray(args[0]) ? args[0] : []
            const isSummaryBackfill = statements.some((statement) => {
              return isRuntimeRecord(statement)
                && "sql" in statement
                && hasRuntimeType(statement.sql, "string")
                && statement.sql.includes("SET summary = json_remove")
            })
            if (isSummaryBackfill && summaryBackfillAttempts++ === 0) {
              return await firstBackfillFailure
            }
            // SAFETY: The proxy receives Client.batch arguments and forwards them unchanged.
            return await (client.batch as (...batchArgs: unknown[]) => Promise<unknown>)(...args)
          }
        },
      }) as Client
      const store = createLibsqlAgentInvocationStore({ client: transientClient, maxAgeMs: false, maxRecords: false })

      await expect(store.list()).resolves.toEqual({
        invocations: [expect.objectContaining({ id: "legacy-summary-retry" })],
      })
      expect(summaryBackfillAttempts).toBe(1)
      failFirstBackfill()
      await vi.waitFor(async () => {
        await expect(store.getSummary("legacy-summary-retry")).resolves.toMatchObject({
          id: "legacy-summary-retry",
        })
        expect(summaryBackfillAttempts).toBe(2)
        const persisted = await client.execute(
          "SELECT summary FROM vitehub_agent_invocations WHERE id = 'legacy-summary-retry'",
        )
        expect(persisted.rows[0]?.summary).toEqual(expect.any(String))
      })
    }
    finally {
      failFirstBackfill()
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("filters old-shape writes in fresh libSQL journals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-fresh-overlap-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    try {
      const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
      await store.list()
      await client.execute({
        args: ["review completed", JSON.stringify({
          agentName: "review",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "fresh-overlapping-legacy-writer",
          observations: [{
            attributes: { result: "fresh observation-only text" },
            name: "legacy",
            timestamp: "2026-01-01T00:00:00.000Z",
            type: "run",
          }],
          status: "completed",
          traceId: "fresh-overlapping-legacy-trace",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, search, record) VALUES ('fresh-overlapping-legacy-writer', 'completed', ?, ?)",
      })

      await expect(store.list({ agentName: "review" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })],
      })
      await expect(store.list({ search: "fresh observation-only" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })],
      })
      await expect(createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false }).list({ search: "fresh observation-only" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })] })

      await store.update("fresh-overlapping-legacy-writer", {
        status: "running",
        timestamp: "2026-01-01T00:01:00.000Z",
      })
      await client.execute({
        args: ["review completed", JSON.stringify({
          agentName: "review",
          annotations: { writer: "legacy" },
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "fresh-overlapping-legacy-writer",
          observations: [{
            attributes: { result: "updated observation-only text" },
            name: "legacy",
            timestamp: "2026-01-01T00:02:00.000Z",
            type: "run",
          }],
          status: "completed",
          traceId: "fresh-overlapping-legacy-trace",
          updatedAt: "2026-01-01T00:02:00.000Z",
        }), "fresh-overlapping-legacy-writer"],
        sql: "UPDATE vitehub_agent_invocations SET search = ?, record = ? WHERE id = ?",
      })
      const overlappingUpdate = await client.execute(
        "SELECT status, summary, updated_at FROM vitehub_agent_invocations WHERE id = 'fresh-overlapping-legacy-writer'",
      )
      expect(overlappingUpdate.rows[0]?.status).toBe("completed")
      expect(overlappingUpdate.rows[0]?.updated_at).toBe("2026-01-01T00:02:00.000Z")
      expect(JSON.parse(String(overlappingUpdate.rows[0]?.summary))).toMatchObject({
        annotations: { writer: "legacy" },
        status: "completed",
      })
      expect(JSON.parse(String(overlappingUpdate.rows[0]?.summary))).not.toHaveProperty("observations")
      await expect(store.list({ search: "updated observation-only" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })],
      })
      await expect(createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false }).list({ search: "updated observation-only" }))
        .resolves.toMatchObject({ invocations: [expect.objectContaining({ id: "fresh-overlapping-legacy-writer" })] })
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("backfills libSQL search in retryable bounded pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-paged-migration-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    try {
      await client.execute(`CREATE TABLE vitehub_agent_invocations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        search TEXT,
        record TEXT NOT NULL
      )`)
      const timestamp = "2026-01-01T00:00:00.000Z"
      await client.batch(Array.from({ length: 205 }, (_, index) => ({
        args: [`legacy-${index}`, JSON.stringify({
          annotations: { repository: `repository-${index}` },
          createdAt: timestamp,
          id: `legacy-${index}`,
          observations: [],
          status: "completed",
          traceId: `trace-${index}`,
          updatedAt: timestamp,
        })],
        sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES (?, 'completed', ?)",
      })), "write")

      const pageSizes: number[] = []
      let failPage = 2
      const flakyClient = new Proxy(client, {
        get(target, property) {
          if (property === "batch") {
            return async (...args: Parameters<Client["batch"]>) => {
              const statements = args[0]
              const firstStatement = statements[0]
              if (hasRuntimeType(firstStatement, "object")
                && "sql" in firstStatement && hasRuntimeType(firstStatement.sql, "string")
                && firstStatement.sql.includes("SET search")) {
                pageSizes.push(statements.length)
                if (--failPage === 0) throw new Error("migration interrupted")
              }
              return target.batch(...args)
            }
          }
          const value = Reflect.get(target, property)
          return hasRuntimeType(value, "function") ? value.bind(target) : value
        },
      })
      const store = createLibsqlAgentInvocationStore({ client: flakyClient })

      await expect(store.list({ search: "repository-204" })).rejects.toThrow("migration interrupted")
      const committed = await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations WHERE search IS NOT NULL")
      expect(Number(committed.rows[0]?.count)).toBe(100)

      failPage = -1
      await expect(store.list({ search: "repository-204" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "legacy-204" })],
      })
      expect(pageSizes).toEqual([100, 100, 100, 5])
      const remaining = await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations WHERE search IS NULL")
      expect(Number(remaining.rows[0]?.count)).toBe(0)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("recovers expired libSQL writer leases and fences previous writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocation-lease-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    const store = createLibsqlAgentInvocationStore({ client })
    const createdAt = new Date().toISOString()
    try {
      await store.create({
        createdAt,
        id: "invocation-1",
        observations: [],
        status: "pending",
        traceId: "trace-1",
        updatedAt: createdAt,
      })
      await store.create({
        createdAt,
        id: "legacy-writer",
        observations: [],
        status: "pending",
        traceId: "legacy-writer-trace",
        updatedAt: createdAt,
      })
      await expect(client.execute({
        args: ["legacy-writer", "legacy", Date.now() + 30_000],
        sql: `INSERT INTO vitehub_agent_invocations_claims (id, claim_id, expires_at)
          VALUES (?, ?, ?)`,
      })).resolves.toMatchObject({ rowsAffected: 1 })
      await expect(client.execute({
        args: ["legacy-writer"],
        sql: `SELECT claimed_at, claim_token FROM vitehub_agent_invocations_claims WHERE id = ?`,
      })).resolves.toMatchObject({ rows: [{ claimed_at: 0, claim_token: "" }] })
      await expect(store.claim("invocation-1", "first", 30_000)).resolves.toBe(true)
      await client.execute({
        args: ["invocation-1"],
        sql: "UPDATE vitehub_agent_invocations_claims SET claim_token = '' WHERE id = ?",
      })
      await expect(store.claim("invocation-1", "second", 30_000)).resolves.toBe(false)
      await expect(store.claim("invocation-1", "first", 30_000)).resolves.toBe(true)
      const firstClaimToken = await store.getClaimToken("invocation-1")
      expect(firstClaimToken).toEqual(expect.any(String))
      await expect(store.claim("invocation-1", "second", 30_000, { replaceClaimToken: "not-first" })).resolves.toBe(false)
      await expect(store.claim("invocation-1", "second", 30_000, { replaceClaimToken: firstClaimToken })).resolves.toBe(true)
      await expect(store.getClaimToken("invocation-1")).resolves.not.toBe(firstClaimToken)
      await store.release("invocation-1", "second")
      await expect(store.claim("invocation-1", "first", 30_000)).resolves.toBe(true)
      const localNow = Date.now()
      const clock = vi.spyOn(Date, "now").mockReturnValue(localNow + 60_000)
      await expect(store.claim("invocation-1", "second", 30_000)).resolves.toBe(false)
      clock.mockRestore()
      await client.execute({
        args: ["invocation-1"],
        sql: "UPDATE vitehub_agent_invocations_claims SET expires_at = 0 WHERE id = ?",
      })
      await expect(store.claim("invocation-1", "second", 30_000)).resolves.toBe(true)
      await expect(store.update("invocation-1", {
        status: "failed",
        timestamp: new Date().toISOString(),
      }, "first")).resolves.toBeUndefined()
      await expect(store.update("invocation-1", {
        status: "running",
        timestamp: new Date().toISOString(),
      }, "second")).resolves.toMatchObject({ status: "running" })
      await store.release("invocation-1", "second")
      await expect(store.claim("invocation-1", "third", 30_000)).resolves.toBe(true)
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("retries libSQL initialization after a transient failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-retry-"))
    const client = createClient({ url: `file:${join(directory, "invocations.sqlite")}` })
    let fail = true
    const flakyClient = new Proxy(client, {
      get(target, property) {
        if (property === "execute") {
          return (...args: Parameters<Client["execute"]>) => {
            if (fail) {
              fail = false
              throw new Error("database temporarily unavailable")
            }
            return target.execute(...args)
          }
        }
        const value = Reflect.get(target, property)
        return hasRuntimeType(value, "function") ? value.bind(target) : value
      },
    })
    const invocations = defineAgentInvocations({
      store: createLibsqlAgentInvocationStore({ client: flakyClient }),
    })
    try {
      await expect(invocations.getByRunId("run-1")).rejects.toThrow("temporarily unavailable")
      await expect(invocations.getByRunId("run-1")).resolves.toBeUndefined()
    }
    finally {
      client.close()
      await rm(directory, { force: true, recursive: true })
    }
  })
})
