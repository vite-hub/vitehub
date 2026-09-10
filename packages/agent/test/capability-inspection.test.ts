import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, it, vi } from "vitest"
import { defineAgent, defineCapability, runAgent } from "../src/index.ts"
import { createAgentInvocationContextStore, agentInvocationConfigurationUpdatedContextKey } from "../src/invocation-context.ts"
import { getAgentTelemetryConfiguration, setAgentTelemetryConfiguration, setAgentCapabilityInspection, updateAgentTelemetryConfiguration } from "../src/internal/agent-telemetry.ts"
import { mcp } from "../src/capabilities/mcp.ts"
import { title } from "../src/capabilities/title.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import type { AgentInspectionValue } from "../src/types.ts"
import type { AgentInvocationRecord } from "../src/invocations.ts"

const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })
function model() {
  return new MockLanguageModelV3({ doGenerate: {
    content: [{ type: "text", text: "Done" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
    warnings: [],
  } })
}
function configuration(record: AgentInvocationRecord | undefined) {
  return record?.observations.findLast(entry => entry.name === "vitehub.agent.configured")?.attributes?.["vitehub.agent.configuration"]
}
function journal(configuration: "content" | "metadata" = "content") {
  return defineAgentInvocations({ configuration, store: createMemoryAgentInvocationStore() })
}

describe("Capability inspection snapshots", () => {
  it("serializes inspection and tool updates without losing intermediate state or tool contracts", async () => {
    const context = createAgentInvocationContextStore()
    await setAgentTelemetryConfiguration(context, { capabilities: [{ id: "custom" }], driver: { kind: "run" }, runtime: { name: "unknown" } })
    const observed: string[] = []
    context.set(agentInvocationConfigurationUpdatedContextKey, async () => { observed.push(JSON.stringify(getAgentTelemetryConfiguration(context)?.value)) })
    await Promise.all([
      setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { status: "Working" } }),
      updateAgentTelemetryConfiguration(context, { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }),
      setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { status: "Finished" } }),
    ])
    expect(observed).toHaveLength(3)
    expect(observed[0]).toContain('"Working"')
    expect(observed[1]).toContain('"lookup"')
    expect(observed[2]).toContain('"Finished"')
    expect(getAgentTelemetryConfiguration(context)?.value.tools).toEqual([{ name: "lookup", inputSchema: { type: "object" } }])
  })

  it("retains nested inspection data and marks non-serializable omissions", async () => {
    const context = createAgentInvocationContextStore()
    await setAgentTelemetryConfiguration(context, { capabilities: [{ id: "custom" }], driver: { kind: "run" }, runtime: { name: "unknown" } })
    let nested: AgentInspectionValue = "leaf"
    for (let index = 0; index < 16; index++) nested = { child: nested }
    await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: { nested } })
    expect(getAgentTelemetryConfiguration(context)?.value.capabilities?.[0]?.inspection?.state).toEqual({ nested })
    const cyclic: Record<string, AgentInspectionValue> = {}
    cyclic.self = cyclic
    await setAgentCapabilityInspection(context, "custom", { label: "Custom", state: cyclic })
    expect(getAgentTelemetryConfiguration(context)?.value.capabilities?.[0]?.inspection).toMatchObject({ truncated: true, state: {} })
  })

  it("captures MCP servers and exact tool provenance once, including empty and skipped servers", async () => {
    const tools = vi.fn(async () => ({ "read-doc": {
      description: "Read a document.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      outputSchema: { type: "string" },
      execute: async () => "document",
    } }))
    const close = vi.fn()
    const invocations = journal()
    const capability = mcp({ servers: {
      "docs-server": () => ({ tools, close }),
      empty: { tools: async () => ({}), close: vi.fn() },
      optional: () => false,
    } })
    await runAgent(defineAgent({ capabilities: [capability], driver: { model: model() }, invocations }), runtime("mcp-inspection"), { prompt: "Read docs" })
    const record = await invocations.getByRunId("mcp-inspection")
    expect(configuration(record)).toMatchObject({
      capabilities: [{ id: "mcp", inspection: { label: "MCP", view: capability.inspection?.view, state: { servers: [
        { name: "docs-server", status: "Resolved" },
        { name: "empty", status: "Resolved" },
        { name: "optional", status: "Skipped" },
      ] } } }],
      tools: [{ name: "mcp_docs_server_read_doc", capabilityId: "mcp", mcp: { server: "docs-server", name: "read-doc" }, description: "Read a document.", inputSchema: { required: ["path"] }, outputSchema: { type: "string" } }],
    })
    await invocations.getByRunId("mcp-inspection")
    expect(tools).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("captures final MCP contracts after replacement, renaming and removal", async () => {
    const tools = vi.fn(async () => ({
      read: { description: "Original", inputSchema: { type: "object" }, execute: async () => "read" },
      removed: { inputSchema: { type: "object" }, execute: async () => "removed" },
    }))
    const invocations = journal()
    const replace = defineCapability({ id: "replace", resolve(context) {
      context.tools.transform(current => ({ ...current, mcp_docs_read: {
        name: "mcp_docs_read", description: "Replacement", inputSchema: { type: "string" }, execute: async () => "replacement",
      } }))
      context.tools.transform(current => ({ renamed: { ...current!.mcp_docs_read!, name: "renamed" } }))
    } })
    await runAgent(defineAgent({ cli: { capabilities: false }, capabilities: [mcp({ servers: { docs: { tools, close: vi.fn() } } }), replace], driver: { model: model() }, invocations }), runtime("mcp-transformed"), { prompt: "Read docs" })
    expect(configuration(await invocations.getByRunId("mcp-transformed"))).toMatchObject({
      tools: [{ name: "renamed", capabilityId: "mcp", mcp: { server: "docs", name: "read" }, description: "Replacement", inputSchema: { type: "string" } }],
    })
    expect(tools).toHaveBeenCalledTimes(1)
  })

  it.each(["resolve", "discover"])("retains MCP %s failure state without reconnecting or hiding the failure", async (phase) => {
    const invocations = journal()
    const failure = new Error("Discovery unavailable")
    const close = vi.fn()
    const resolver = vi.fn(() => {
      if (phase === "resolve") throw failure
      return { tools: async () => { throw failure }, close }
    })
    await expect(runAgent(defineAgent({ capabilities: [mcp({ servers: { broken: resolver } })], driver: { model: model() }, invocations }), runtime(`mcp-${phase}`), {})).rejects.toThrow("Discovery unavailable")
    expect(configuration(await invocations.getByRunId(`mcp-${phase}`))).toMatchObject({ capabilities: [{ id: "mcp", inspection: { state: { servers: [{ name: "broken", status: phase === "resolve" ? "Resolution failed" : "Discovery failed" }] } } }] })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(phase === "discover" ? 1 : 0)
  })

  it("updates Title snapshots for custom IDs and isolates concurrent Invocations", async () => {
    const invocations = journal()
    const execute = vi.fn(({ text }: { text: string }) => text)
    const capability = title({ id: "conversation-title", execute })
    const agent = defineAgent({ capabilities: [capability], driver: { run: () => "Done" }, invocations })
    await Promise.all(["First title", "Second title"].map(prompt => runAgent(agent, runtime(prompt), { prompt })))
    for (const value of ["First title", "Second title"]) {
      const record = await invocations.getByRunId(value)
      expect(configuration(record)).toMatchObject({ capabilities: [{ id: "conversation-title", inspection: { label: "Title", state: { status: "Completed", title: value, generation: "Custom execute", maxLength: 39 } } }] })
      expect(JSON.stringify(record?.observations)).toContain('"Generating"')
      expect(JSON.stringify(record?.observations)).not.toContain(value === "First title" ? "Second title" : "First title")
      const fingerprints = new Set(record?.observations.filter(entry => entry.name === "vitehub.agent.configured").map(entry => entry.attributes?.["vitehub.agent.configuration.fingerprint"]))
      expect(fingerprints.size).toBe(1)
    }
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("keeps inspection content out of metadata-only journals", async () => {
    const invocations = journal("metadata")
    await runAgent(defineAgent({ capabilities: [title({ execute: () => "Private result" })], driver: { run: () => "Done" }, invocations }), runtime("metadata-inspection"), { prompt: "Private input" })
    const snapshot = configuration(await invocations.getByRunId("metadata-inspection"))
    expect(snapshot).toMatchObject({ capabilities: [{ id: "title", inspection: { label: "Title" } }] })
    expect(JSON.stringify(snapshot)).not.toContain("Private result")
    expect(JSON.stringify(snapshot)).not.toContain('"state"')
    expect(JSON.stringify(snapshot)).not.toContain('"view"')
  })

  it.each([false, true])("respects independent telemetry content choices with full capture %s", async (full) => {
    const exporter = vi.fn()
    const tasks: Promise<unknown>[] = []
    await runAgent(defineAgent({ capabilities: [
      title({ execute: () => "Private title" }),
      defineCapability({ id: "export", telemetry: { exporter, content: { instructions: true, inputs: full, outputs: full } } }),
    ], driver: { run: () => "Done" } }), { ...runtime("telemetry-inspection"), waitUntil: task => { tasks.push(task) } }, { prompt: "Private input" })
    await Promise.all(tasks)
    expect(exporter).toHaveBeenCalled()
    const captured = JSON.stringify(exporter.mock.calls)
    if (full) expect(captured).toContain('"state"')
    else expect(captured).not.toContain('"state"')
  })

  it.each([false, true])("finishes Title inspection without generation for skipped=%s", async (skip) => {
    const invocations = journal()
    const execute = vi.fn(() => "Unused")
    await runAgent(defineAgent({ capabilities: [title({ execute, when: () => !skip })], driver: { run: () => "Done" }, invocations }), runtime("no-title"), skip ? { prompt: "Skip" } : {})
    expect(configuration(await invocations.getByRunId("no-title"))).toMatchObject({ capabilities: [{ id: "title", inspection: { state: { status: skip ? "Skipped" : "No title generated" } } }] })
    expect(execute).not.toHaveBeenCalled()
  })

  it("captures capability-owned state through the public API and redacts credential fields", async () => {
    const invocations = journal()
    await runAgent(defineAgent({ capabilities: [defineCapability({
      id: "example",
      inspection: { label: "Example" },
      async configure(context) { await context.inspection.set({ status: "Ready", apiToken: "private-key" }) },
      async close(context) { await context.inspection.set({ status: "Closed", apiToken: "private-key" }) },
    })], driver: { run: () => "Done" }, invocations }), runtime("custom-inspection"), {})
    const snapshot = configuration(await invocations.getByRunId("custom-inspection"))
    expect(snapshot).toMatchObject({ capabilities: [{ id: "example", inspection: { label: "Example", state: { status: "Closed", apiToken: "[redacted]" } } }] })
    expect(JSON.stringify(snapshot)).not.toContain("private-key")
  })
})
