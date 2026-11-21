import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

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

const app = "https://agent.example.com"

interface ListInput { cursor?: string, limit?: number }

/** The Console of a deployed app. `poll` returns the records for each poll, or a failure. The CLI filters them by status. */
function appConsole(poll: (index: number) => Summary[] | { cursor?: string, invocations: Summary[] } | "unavailable") {
  const inputs: ListInput[] = []
  let polls = 0
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const input = operationRpcRequest(init?.body).input as ListInput
    inputs.push(input)
    const page = poll(input.cursor === undefined ? polls++ : polls - 1)
    if (page === "unavailable") return operationRpcResponse(init?.body, { code: "UNAVAILABLE", message: "unavailable", ok: false, status: 503 })
    return operationRpcResponse(init?.body, { ok: true, value: Array.isArray(page) ? { invocations: page } : page })
  })
  // SAFETY: The mock implements the fetch call shape that the CLI uses.
  return { fetch: fetch as unknown as typeof globalThis.fetch, inputs }
}

async function waitIdle(args: string[], fetch: typeof globalThis.fetch) {
  const stdout = stream()
  const stderr = stream()
  const sleeps: number[] = []
  const sleep = async (milliseconds: number) => {
    sleeps.push(milliseconds)
    vi.setSystemTime(Date.now() + milliseconds)
  }
  const exitCode = await runAgentInvocationsCli(["wait-idle", "--url", app, ...args], { env: {}, stderr, stdout }, { fetch, sleep })
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
    const endpoint = appConsole(() => [summary("done", "completed")])
    const result = await waitIdle([], endpoint.fetch)

    expect(result).toMatchObject({ exitCode: 0, sleeps: [], stdout: "Idle: no pending or running Agent Invocations.\n" })
    expect(endpoint.inputs).toEqual([{ limit: 100 }])
  })

  it("waits until the running Invocations finish and prints them once", async () => {
    const polls = [[summary("a", "running", { agentName: "support" })], [summary("a", "running", { agentName: "support" })], []]
    const endpoint = appConsole(index => polls[index]!)
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
    const endpoint = appConsole(() => [summary("a", "pending")])
    const result = await waitIdle(["--timeout", "30s", "--interval", "10s"], endpoint.fetch)

    expect(result.exitCode).toBe(1)
    expect(result.sleeps).toEqual([10_000, 10_000, 10_000])
    expect(result.stderr).toBe(`Still 1 active Agent Invocation(s) after 30s:\n  a pending - ${minutesAgo(1)}\n`)
  })

  it("reports records older than --stale-after and does not wait on them", async () => {
    const endpoint = appConsole(() => [summary("orphan", "running", { updatedAt: minutesAgo(180) })])
    const result = await waitIdle([], endpoint.fetch)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe(`Ignoring 1 stale Agent Invocation(s) not updated for 2h:\n  orphan running - ${minutesAgo(180)}\n`)
    expect(result.stdout).toBe("Idle: only 1 stale Agent Invocation(s) remain pending or running.\n")

    const strict = await waitIdle(["--stale-after", "4h", "--timeout", "1m", "--interval", "1m"], appConsole(() => [summary("orphan", "running", { updatedAt: minutesAgo(180) })]).fetch)
    expect(strict.exitCode).toBe(1)
  })

  it("waits only on the Agent that --agent names", async () => {
    const endpoint = appConsole(() => [summary("other", "running", { agentName: "triage" })])
    expect((await waitIdle(["--agent", "support"], endpoint.fetch)).exitCode).toBe(0)
  })

  it("follows list cursors on the Console", async () => {
    const endpoint = appConsole(() => endpoint.inputs.at(-1)?.cursor === "next" ? [summary("late", "running")] : { cursor: "next", invocations: [] })
    const result = await waitIdle(["--timeout", "1s"], endpoint.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("  late running")
  })

  it("times out when a paginated idle scan finishes after the deadline", async () => {
    const endpoint = appConsole(() => {
      if (endpoint.inputs.at(-1)?.cursor === undefined) return { cursor: "next", invocations: [] }
      vi.setSystemTime(now.getTime() + 2_000)
      return []
    })
    const result = await waitIdle(["--timeout", "1s"], endpoint.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("Could not confirm that no Agent Invocation is active within 1s.\n")
  })

  it("reads the Console once per poll for a deployed --url", async () => {
    const methods: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(operationRpcRequest(init?.body).operation)
      return operationRpcResponse(init?.body, { ok: true, value: { invocations: [summary("a", "completed"), summary("b", "running")] } })
    })
    // SAFETY: The mock implements the fetch call shape that the CLI uses.
    const result = await waitIdle(["--timeout", "1s", "--json"], fetch as unknown as typeof globalThis.fetch)

    expect(result.exitCode).toBe(1)
    expect(methods).toEqual(["invocations.list", "invocations.list"])
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { active: [summary("b", "running")], event: "invocations.waiting" },
      { active: [summary("b", "running")], event: "invocations.timeout" },
    ])
  })

  it("retries a failed read after the first one, and fails when the first read fails", async () => {
    const polls: Array<Summary[] | "unavailable"> = [[summary("a", "running")], "unavailable", []]
    const result = await waitIdle([], appConsole(index => polls[index]!).fetch)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("Read failed, retrying: Console request failed with HTTP 503: unavailable.\n")

    const unreachable = await waitIdle([], appConsole(() => "unavailable").fetch)
    expect(unreachable).toMatchObject({ exitCode: 1, sleeps: [] })
    expect(unreachable.stderr).toMatch(/^\[AGENT_R0511\] Console request failed with HTTP 503: unavailable\.\n.*fix: /s)
  })

  it.each([
    [["wait-idle", "--timeout", "soon"], "--timeout requires a duration"],
    [["wait-idle", "--stale-after", "0"], "--stale-after requires a positive duration"],
    [["list", "--stale-after", "2h"], "--stale-after is only supported for wait-idle."],
    [["get", "ainv_1", "--agent", "support"], "--agent is only supported for list, wait-idle, export, and capabilities."],
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
