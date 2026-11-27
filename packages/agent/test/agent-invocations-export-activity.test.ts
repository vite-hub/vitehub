import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTraceEventLog } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { invocationActivityLimits } from "../src/invocations/activity.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { type AgentTraceContext, createAgentStreamEventTracer } from "../src/trace.ts"

import type { StreamEvent } from "../src/messages.ts"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

/** Observations as the journal records them: the stream events go through the Agent stream tracer. */
async function traced(events: StreamEvent[]) {
  const traceLog = createTraceEventLog({ content: "content" })
  // SAFETY: Stream tracing only reads the context store and runtime trace fields.
  const tracer = createAgentStreamEventTracer({ context: createAgentInvocationContextStore(), runtime: { traceLog } } as AgentTraceContext)
  for (const event of events) await tracer.write(event)
  await tracer.flush()
  return traceLog.entries()
}

const failingScript = "pnpm vitest run test/sync.test.ts"
const longOutput = `${"x".repeat(5000)}\nFAIL test/sync.test.ts > keeps the cursor\n`

/** Stream events in the shape that `providerEvent` makes from Codex app-server items. */
function codexEvents(): StreamEvent[] {
  const command = (id: string, script: string) => ({ item: { command: `/bin/bash -lc '${script}'`, commandActions: [], cwd: "/workspace", id, status: "inProgress", type: "commandExecution" } })
  return [
    { id: "reasoning_summary_text:rs_1:0", phase: "commentary", text: "**Checking the failing test**", type: "text-delta" },
    { id: "assistant_text:msg_1:0", messageId: "msg_1", phase: "commentary", text: "I will run the sync test.", type: "text-delta" },
    { activity: { kind: "tool" }, id: "exec-1", input: command("exec-1", failingScript), name: "command_execution", title: failingScript, type: "tool-call" },
    { data: { kind: "content.delta", value: { delta: longOutput, streamKind: "command_output" } }, id: "exec-1", type: "data-agent-event" },
    { activity: { kind: "tool" }, durationMs: 4200, error: "Command failed with exit code 1.", id: "exec-1", name: "command_execution", output: { item: { ...command("exec-1", failingScript).item, aggregatedOutput: longOutput, exitCode: 1, status: "failed" } }, title: failingScript, type: "tool-result" },
    { activity: { kind: "tool" }, id: "patch-1", input: { toolName: "file_change", fileName: "/workspace/src/sync.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }, name: "file_change", type: "tool-call" },
    { activity: { kind: "tool" }, durationMs: 12, id: "patch-1", name: "file_change", output: { toolName: "file_change", fileName: "/workspace/src/sync.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }, type: "tool-result" },
    { usageRecord: { cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.010000000000000001" }, model: "gpt-5.5-codex", provider: "codex", usage: { inputTokens: 18_000, inputTokenDetails: { cacheReadTokens: 12_000 }, outputTokens: 900, outputTokenDetails: { reasoningTokens: 400 }, totalTokens: 18_900 } }, type: "usage" },
    { id: "assistant_text:msg_2:0", messageId: "msg_2", phase: "final", text: "Fixed the cursor bug.", type: "text-delta" },
    { reason: "completed", type: "finish" },
  ]
}

/** Stream events of a model Driver: AI SDK tool calls with JSON input and output. */
function modelEvents(): StreamEvent[] {
  return [
    { id: "call_1", input: { query: "sync cursor" }, name: "searchDocs", type: "tool-call" },
    { durationMs: 30, id: "call_1", name: "searchDocs", output: { hits: ["a", "b"] }, type: "tool-result" },
    { id: "call_2", input: { id: 7 }, name: "loadTicket", type: "tool-call" },
    { error: "Ticket 7 not found", id: "call_2", name: "loadTicket", type: "tool-result" },
    { usageRecord: { model: "gpt-5-mini", provider: "openai", usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 } }, type: "usage" },
    { text: "No ticket 7.", type: "text-delta" },
  ]
}

async function fixtureJournal() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-activity-"))
  directories.push(directory)
  const path = join(directory, "journal.sqlite")
  const store = createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url: `file:${path}` })
  const base = { agentName: "dev", status: "completed" as const, updatedAt: "2026-11-10T10:05:00.000Z" }
  const start = (sequence: number, prompt: string) => ({ attributes: { "input.prompt": prompt }, name: "agent.invocation.start", sequence, timestamp: "2026-11-10T10:00:00.000Z", type: "run" as const })
  const renumber = (offset: number, entries: Awaited<ReturnType<typeof traced>>) => entries.map(entry => ({ ...entry, sequence: entry.sequence + offset }))
  await store.create({ ...base, createdAt: "2026-11-10T10:00:00.000Z", id: "codex", observations: [start(0, "Fix the sync test"), ...renumber(1, await traced(codexEvents()))], traceId: "trace-codex" })
  await store.create({ ...base, createdAt: "2026-11-10T11:00:00.000Z", id: "model", observations: [start(0, "Find ticket 7"), ...renumber(1, await traced(modelEvents()))], traceId: "trace-model" })
  return path
}

async function run(args: string[]) {
  const stdout = stream()
  const stderr = stream()
  const fetch = vi.fn()
  // SAFETY: The mock only proves that a journal file read sends no request.
  const exitCode = await runAgentInvocationsCli(args, { env: {}, stderr, stdout }, { fetch: fetch as unknown as typeof globalThis.fetch })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

const lines = (stdout: string) => stdout.trim().split("\n").map(line => JSON.parse(line))

describe("vitehub agent invocations export --activity", () => {
  it("adds one ordered activity trace per Invocation and leaves the default export unchanged", async () => {
    const path = await fixtureJournal()
    const plain = await run(["export", "--database", path])
    const withActivity = await run(["export", "--database", path, "--activity"])
    expect(plain.exitCode).toBe(0)
    expect(withActivity.exitCode).toBe(0)

    const [codex, model] = lines(withActivity.stdout)
    for (const line of lines(plain.stdout)) expect(line).not.toHaveProperty("activity")
    expect(lines(withActivity.stdout).map(({ activity: _activity, ...line }) => line)).toEqual(lines(plain.stdout))

    expect(codex.activity.map((entry: { kind: string }) => entry.kind)).toEqual(["reasoning", "message", "tool", "tool", "usage", "message"])
    expect(codex.activity[0]).toEqual({ at: expect.any(String), kind: "reasoning", text: "**Checking the failing test**" })
    expect(codex.activity[1]).toEqual({ at: expect.any(String), kind: "message", phase: "commentary", text: "I will run the sync test." })
    const failed = codex.activity[2]
    expect(failed).toEqual({
      at: expect.any(String),
      durationMs: 4200,
      error: "Command failed with exit code 1.",
      exitCode: 1,
      id: "exec-1",
      input: failingScript,
      kind: "tool",
      name: "command_execution",
      output: expect.stringMatching(/^\[\d+ chars\+\]…x+\nFAIL test\/sync\.test\.ts > keeps the cursor\n$/),
      outputBytes: longOutput.length,
      status: "failed",
      title: failingScript,
    })
    expect(failed.output.length).toBeLessThan(invocationActivityLimits.failedOutput + 32)
    expect.soft(codex.activity[3]).toEqual({ at: expect.any(String), durationMs: 12, id: "patch-1", kind: "tool", name: "file_change", outputBytes: expect.any(Number), paths: ["/workspace/src/sync.ts"], status: "completed" })
    expect.soft(codex.activity[4]).toEqual({ at: expect.any(String), cachedInputTokens: 12_000, costUsd: "0.010000000000000001", inputTokens: 18_000, kind: "usage", model: "gpt-5.5-codex", outputTokens: 900, provider: "codex", reasoningTokens: 400, totalTokens: 18_900 })
    expect(codex.activity[5]).toEqual({ at: expect.any(String), kind: "message", phase: "final", text: "Fixed the cursor bug." })

    expect(model.activity).toEqual([
      { at: expect.any(String), durationMs: 30, id: "call_1", input: "{\"query\":\"sync cursor\"}", kind: "tool", name: "searchDocs", outputBytes: 18, status: "completed" },
      { at: expect.any(String), durationMs: expect.any(Number), error: "Ticket 7 not found", id: "call_2", input: "{\"id\":7}", kind: "tool", name: "loadTicket", status: "failed" },
      { at: expect.any(String), inputTokens: 1200, kind: "usage", model: "gpt-5-mini", outputTokens: 80, provider: "openai", totalTokens: 1280 },
      { at: expect.any(String), kind: "message", text: "No ticket 7." },
    ])
  })

  it("keeps paths from native file-change items", async () => {
    const { invocationActivityTrace } = await import("../src/invocations/activity.ts")
    const trace = invocationActivityTrace([
      { attributes: { "tool.id": "patch", "tool.input": { item: { changes: [{ path: "/workspace/src/sync.ts" }] } }, "tool.name": "file_change" }, name: "agent.tool.start", sequence: 1, timestamp: "2026-11-10T10:00:00.000Z", type: "run" },
    ])
    expect(trace.activity[0]).toMatchObject({ paths: ["/workspace/src/sync.ts"] })
    expect(trace.activity[0]).not.toHaveProperty("input")
  })

  it("cuts long text and caps the entries", async () => {
    const { invocationActivityTrace } = await import("../src/invocations/activity.ts")
    const observations = Array.from({ length: invocationActivityLimits.entries + 5 }, (_, index) => ({
      attributes: { "tool.id": `t${index}`, "tool.input": "y".repeat(invocationActivityLimits.text + 10), "tool.name": "read_file" },
      name: "agent.tool.start",
      sequence: index,
      timestamp: "2026-11-10T10:00:00.000Z",
      type: "run" as const,
    }))
    const trace = invocationActivityTrace(observations)
    expect(trace.activity).toHaveLength(invocationActivityLimits.entries)
    expect(trace.activityOmitted).toBe(5)
    expect(trace.activity[0]).toMatchObject({ input: `${"y".repeat(invocationActivityLimits.text)}…[+10 chars]`, status: "running" })
  })

  it("says when the journal omitted or shortened tool content", async () => {
    const { invocationActivityTrace } = await import("../src/invocations/activity.ts")
    const trace = invocationActivityTrace([
      { attributes: { "content.omitted": ["tool.input"], "tool.id": "a", "tool.name": "exec_command" }, name: "agent.tool.start", sequence: 1, timestamp: "2026-11-10T10:00:00.000Z", type: "run" },
      { attributes: { "tool.id": "a", "tool.output": "partial", "vitehub.observation.truncated": true, "vitehub.observation.truncatedAttributes": ["tool.output"] }, name: "agent.tool.finish", sequence: 2, timestamp: "2026-11-10T10:00:01.000Z", type: "run" },
    ])
    expect(trace.activity).toEqual([{ at: "2026-11-10T10:00:00.000Z", contentOmitted: ["tool.input"], durationMs: 1000, id: "a", kind: "tool", name: "exec_command", outputBytes: 7, recordTruncated: true, status: "completed" }])
  })

  it("rejects --activity outside export", async () => {
    const result = await run(["list", "--activity"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--activity is only supported for export.")
  })
})
