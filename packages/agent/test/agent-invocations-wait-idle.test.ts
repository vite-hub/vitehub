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

const now = new Date("2026-10-06T12:00:00.000Z")
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

function summary(id: string, status: string, options: { agentName?: string, updatedAt?: string } = {}) {
  return { createdAt: minutesAgo(10), cursor: id, id, status, traceId: `trace-${id}`, updatedAt: options.updatedAt ?? minutesAgo(1), ...(options.agentName ? { agentName: options.agentName } : {}) }
}

type Summary = ReturnType<typeof summary>

/** A local invocation endpoint. `poll` returns the records for each poll; the endpoint filters them by status. */
function invocationEndpoint(poll: (index: number) => Summary[] | Response) {
  const urls: URL[] = []
  let polls = 0
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input)
    urls.push(url)
    // Each poll reads pending first, then running.
    const index = url.searchParams.get("status") === "pending" && !url.searchParams.has("cursor") ? polls++ : polls - 1
    const records = poll(index)
    if (records instanceof Response) return records
    return Response.json({ invocations: records.filter(record => record.status === url.searchParams.get("status")) })
  })
  // SAFETY: The mock implements the fetch call shape that the CLI uses.
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls }
}

async function waitIdle(args: string[], fetch: typeof globalThis.fetch) {
  const stdout = stream()
  const stderr = stream()
  const sleeps: number[] = []
  const sleep = async (milliseconds: number) => {
    sleeps.push(milliseconds)
    vi.setSystemTime(Date.now() + milliseconds)
  }
  const exitCode = await runAgentInvocationsCli(["wait-idle", ...args], { env: {}, stderr, stdout }, { fetch, sleep })
  return { exitCode, sleeps, stderr: stderr.output(), stdout: stdout.output() }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("vitehub agent invocations wait-idle", () => {
  it("exits 0 at once when no Invocation is pending or running", async () => {
    const endpoint = invocationEndpoint(() => [summary("done", "completed")])
    const result = await waitIdle([], endpoint.fetch)

    expect(result).toMatchObject({ exitCode: 0, sleeps: [], stdout: "Idle: no pending or running Agent Invocations.\n" })
    expect(endpoint.urls.map(url => url.searchParams.get("status"))).toEqual(["pending", "running"])
  })

  it("waits until the running Invocations finish and prints them once", async () => {
    const polls = [[summary("a", "running", { agentName: "support" })], [summary("a", "running", { agentName: "support" })], []]
    const endpoint = invocationEndpoint(index => polls[index]!)
    const result = await waitIdle(["--interval", "5s"], endpoint.fetch)

    expect(result.exitCode).toBe(0)
    expect(result.sleeps).toEqual([5_000, 5_000])
    expect(result.stdout).toBe([
      "Waiting for 1 active Agent Invocation(s):",
      `  a running support ${minutesAgo(1)}`,
      "Idle: no pending or running Agent Invocations.",
      "",
    ].join("\n"))
  })

  it("exits 1 when --timeout passes with work still active", async () => {
    const endpoint = invocationEndpoint(() => [summary("a", "pending")])
    const result = await waitIdle(["--timeout", "30s", "--interval", "10s"], endpoint.fetch)

    expect(result.exitCode).toBe(1)
    expect(result.sleeps).toEqual([10_000, 10_000, 10_000])
    expect(result.stderr).toBe(`Still 1 active Agent Invocation(s) after 30s:\n  a pending - ${minutesAgo(1)}\n`)
  })

  it("reports records older than --stale-after and does not wait on them", async () => {
    const endpoint = invocationEndpoint(() => [summary("orphan", "running", { updatedAt: minutesAgo(180) })])
    const result = await waitIdle([], endpoint.fetch)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe(`Ignoring 1 stale Agent Invocation(s) not updated for 2h:\n  orphan running - ${minutesAgo(180)}\n`)
    expect(result.stdout).toBe("Idle: only 1 stale Agent Invocation(s) remain pending or running.\n")

    const strict = await waitIdle(["--stale-after", "4h", "--timeout", "1m", "--interval", "1m"], invocationEndpoint(() => [summary("orphan", "running", { updatedAt: minutesAgo(180) })]).fetch)
    expect(strict.exitCode).toBe(1)
  })

  it("waits only on the Agent that --agent names", async () => {
    const endpoint = invocationEndpoint(() => [summary("other", "running", { agentName: "triage" })])
    expect((await waitIdle(["--agent", "support"], endpoint.fetch)).exitCode).toBe(0)
  })

  it("follows list cursors on the invocation endpoint", async () => {
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.searchParams.get("status") === "running" && !url.searchParams.has("cursor")) return Response.json({ cursor: "next", invocations: [] })
      if (url.searchParams.get("cursor") === "next") return Response.json({ invocations: [summary("late", "running")] })
      return Response.json({ invocations: [] })
    })
    // SAFETY: The mock implements the fetch call shape that the CLI uses.
    const result = await waitIdle(["--timeout", "1s"], fetch as unknown as typeof globalThis.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("  late running")
  })

  it("reads the Console once per poll for a deployed --url", async () => {
    const methods: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(JSON.parse(String(init?.body)).method)
      return Response.json({ ok: true, value: { invocations: [summary("a", "completed"), summary("b", "running")] } })
    })
    // SAFETY: The mock implements the fetch call shape that the CLI uses.
    const result = await waitIdle(["--url", "https://agent.example.com", "--timeout", "1s", "--json"], fetch as unknown as typeof globalThis.fetch)

    expect(result.exitCode).toBe(1)
    expect(methods).toEqual(["vitehub:console:invocations", "vitehub:console:invocations"])
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { active: [summary("b", "running")], event: "invocations.waiting" },
      { active: [summary("b", "running")], event: "invocations.timeout" },
    ])
  })

  it("retries a failed read after the first one, and fails when the first read fails", async () => {
    const polls: Array<Summary[] | Response> = [[summary("a", "running")], new Response("unavailable", { status: 503 }), []]
    const result = await waitIdle([], invocationEndpoint(index => polls[index]!).fetch)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("Read failed, retrying: unavailable\n")

    const unreachable = await waitIdle([], invocationEndpoint(() => new Response("unavailable", { status: 503 })).fetch)
    expect(unreachable).toMatchObject({ exitCode: 1, sleeps: [], stderr: "unavailable\n" })
  })

  it.each([
    [["wait-idle", "--timeout", "soon"], "--timeout requires a duration"],
    [["wait-idle", "--stale-after", "0"], "--stale-after requires a positive duration"],
    [["list", "--stale-after", "2h"], "--stale-after is only supported for wait-idle."],
    [["list", "--agent", "support"], "--agent is only supported for wait-idle."],
  ])("rejects %j", async (args, message) => {
    const stderr = stream()
    const fetch = vi.fn()
    // SAFETY: The mock is never called; the arguments fail first.
    const exitCode = await runAgentInvocationsCli(args, { env: {}, stderr, stdout: stream() }, { fetch: fetch as unknown as typeof globalThis.fetch })
    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain(message)
    expect(fetch).not.toHaveBeenCalled()
  })
})
