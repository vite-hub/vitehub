import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"

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

const now = new Date("2026-10-08T12:00:00.000Z")
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

interface Observation { attributes?: Record<string, unknown>, name: string, sequence: number, timestamp: string }

function summary(id: string, options: { agentName?: string, createdAt?: string, origin?: string, status?: string } = {}) {
  const createdAt = options.createdAt ?? daysAgo(1)
  return {
    ...(options.agentName ? { agentName: options.agentName } : {}),
    createdAt,
    cursor: `cursor-${id}`,
    id,
    ...(options.origin ? { origin: options.origin } : {}),
    status: options.status ?? "completed",
    traceId: `trace-${id}`,
    updatedAt: createdAt,
  }
}

type Summary = ReturnType<typeof summary>

const observation = (sequence: number, name: string, attributes: Record<string, unknown>): Observation => ({ attributes, name, sequence, timestamp: now.toISOString() })

/** A local invocation endpoint that filters the list by status and answers each detail request. */
function invocationEndpoint(records: Summary[], observations: Record<string, Observation[]> = {}) {
  const details: string[] = []
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input)
    const id = /\/api\/invocations\/([^/]+)$/.exec(url.pathname)?.[1]
    if (id) {
      details.push(id)
      return Response.json({ invocation: records.find(record => record.id === id), observations: observations[id] ?? [] })
    }
    return Response.json({ invocations: records.filter(record => record.status === url.searchParams.get("status")) })
  })
  // SAFETY: The mock implements the fetch call shape that the CLI uses.
  return { details, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function run(args: string[], fetch: typeof globalThis.fetch) {
  const stdout = stream()
  const stderr = stream()
  const exitCode = await runAgentInvocationsCli(args, { env: {}, stderr, stdout }, { fetch })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

const lines = (stdout: string) => stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("vitehub agent invocations export", () => {
  it("prints one JSON line per Invocation, oldest first, with the prompt, final text, and deliveries", async () => {
    const endpoint = invocationEndpoint([summary("b", { createdAt: daysAgo(1) }), summary("a", { createdAt: daysAgo(2), status: "failed" })], {
      a: [
        observation(1, "agent.invocation.start", { "agent.run.id": "run-a", "input.prompt": "Why did the import fail?" }),
        observation(2, "agent.message.delta", { "message.content": "Draft", "message.phase": "commentary" }),
        observation(3, "agent.message.delta", { "message.content": "The file ", "message.phase": "final" }),
        observation(4, "agent.message.delta", { "message.content": "was empty.", "message.phase": "final_answer" }),
        observation(5, "agent.channel.delivery.effect", { "channel.effect.channel": "teams", "channel.effect.content": "The file was empty.", "channel.effect.intent": "reply", "channel.effect.kind": "reply" }),
        observation(6, "agent.channel.delivery.effect", { "channel.effect.channel": "teams", "channel.effect.content": "Done", "channel.effect.intent": "title", "channel.effect.kind": "title", "channel.effect.skipped": "dry-run" }),
      ],
      b: [
        observation(1, "agent.invocation.start", { "input.prompt": "Hello" }),
        observation(2, "agent.message.delta", { "message.content": "partial", "message.phase": "final" }),
        observation(3, "agent.invocation.finish", { "result.text": "Hello there." }),
      ],
    })
    const result = await run(["export"], endpoint.fetch)

    expect(result.exitCode).toBe(0)
    expect(lines(result.stdout)).toEqual([
      {
        createdAt: daysAgo(2),
        deliveries: [
          { channel: "teams", content: "The file was empty.", intent: "reply", kind: "reply" },
          { channel: "teams", content: "Done", intent: "title", kind: "title", skipped: "dry-run" },
        ],
        final: "The file was empty.",
        id: "a",
        prompt: "Why did the import fail?",
        runId: "run-a",
        status: "failed",
        traceId: "trace-a",
        updatedAt: daysAgo(2),
      },
      { createdAt: daysAgo(1), deliveries: [], final: "Hello there.", id: "b", prompt: "Hello", status: "completed", traceId: "trace-b", updatedAt: daysAgo(1) },
    ])
  })

  it("includes every observation with --observations", async () => {
    const observations = [observation(1, "agent.invocation.start", { "input.prompt": "Hi" })]
    const result = await run(["export", "--observations"], invocationEndpoint([summary("a")], { a: observations }).fetch)
    expect(lines(result.stdout)[0].observations).toEqual(observations)
  })

  it("filters by origin, Agent, status, and creation time before it reads any record", async () => {
    const endpoint = invocationEndpoint([
      summary("match", { agentName: "support", createdAt: daysAgo(2), origin: "teams" }),
      summary("old", { agentName: "support", createdAt: daysAgo(9), origin: "teams" }),
      summary("other-origin", { agentName: "support", createdAt: daysAgo(2), origin: "schedule" }),
      summary("other-agent", { agentName: "triage", createdAt: daysAgo(2), origin: "teams" }),
      summary("failed", { agentName: "support", createdAt: daysAgo(2), origin: "teams", status: "failed" }),
    ])
    const result = await run(["export", "--origin", "teams", "--agent=support", "--since", "7d", "--status", "completed"], endpoint.fetch)

    expect(result.exitCode).toBe(0)
    expect(lines(result.stdout).map(line => line.id)).toEqual(["match"])
    expect(endpoint.details).toEqual(["match"])
  })

  it.each([
    ["7d", daysAgo(7)],
    ["36h", daysAgo(1.5)],
    ["2026-10-05", "2026-10-05T00:00:00.000Z"],
    ["2026-10-05T06:30:00+02:00", "2026-10-05T04:30:00.000Z"],
  ])("selects Invocations created at or after --since %s", async (since, time) => {
    const before = new Date(Date.parse(time) - 1).toISOString()
    const endpoint = invocationEndpoint([summary("at", { createdAt: time }), summary("before", { createdAt: before })])
    const result = await run(["export", "--since", since], endpoint.fetch)
    expect(lines(result.stdout).map(line => line.id)).toEqual(["at"])
  })

  it("reads every status in one pass over the Console pages", async () => {
    const pages = [
      { cursor: "page-2", invocations: [summary("a", { status: "running" })] },
      { invocations: [summary("b", { status: "cancelled" })] },
    ]
    const methods: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const { input, method } = JSON.parse(String(init?.body))
      methods.push(method)
      if (method === "vitehub:console:invocation") return Response.json({ ok: true, value: { invocation: summary(input.id, { status: input.id === "a" ? "running" : "cancelled" }), observations: [] } })
      return Response.json({ ok: true, value: pages.shift() })
    })
    // SAFETY: The mock implements the fetch call shape that the CLI uses.
    const result = await run(["export", "--url", "https://agent.example.com"], fetch as unknown as typeof globalThis.fetch)

    expect(lines(result.stdout).map(line => line.id)).toEqual(["a", "b"])
    expect(methods).toEqual(["vitehub:console:invocations", "vitehub:console:invocations", "vitehub:console:invocation", "vitehub:console:invocation"])
  })

  it.each([
    [["export", "--since", "7"], "--since requires a duration such as 7d or an ISO date"],
    [["export", "--since", "last week"], "--since requires a duration such as 7d or an ISO date"],
    [["export", "--status", "stuck"], "--status must be one of pending, running, completed, failed, cancelled."],
    [["list", "--origin", "teams"], "--origin is only supported for export."],
    [["list", "--observations"], "--observations is only supported for export."],
    [["export", "ainv_1"], "Unexpected argument: ainv_1."],
  ])("rejects %j", async (args, message) => {
    const fetch = vi.fn()
    // SAFETY: The mock is never called; the arguments fail first.
    const result = await run(args, fetch as unknown as typeof globalThis.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(message)
    expect(fetch).not.toHaveBeenCalled()
  })
})
