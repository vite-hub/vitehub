import { describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/cli.ts"
import { isRuntimeRecord } from "../src/internal/runtime-type.ts"

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

function summary(id: string, status: string) {
  return { createdAt: "2026-10-06T10:00:00.000Z", cursor: id, id, status, traceId: `trace-${id}`, updatedAt: "2026-10-06T10:01:00.000Z" }
}

interface ConsoleCall {
  headers: Headers
  input: Record<string, unknown>
  method: string
  url: string
}

/** A deployed Console that answers RPC calls with `reply`. */
function deployedConsole(reply: (call: ConsoleCall) => unknown) {
  const calls: ConsoleCall[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const envelope: unknown = JSON.parse(String(init?.body))
    if (!isRuntimeRecord(envelope) || !isRuntimeRecord(envelope.input) || typeof envelope.method !== "string") throw new Error("Invalid Console envelope")
    const call = { headers: new Headers(init?.headers), input: envelope.input, method: envelope.method, url }
    calls.push(call)
    const value = reply(call)
    return value instanceof Response ? value : Response.json({ ok: true, value })
  })
  // SAFETY: The mock implements the fetch call shape that the CLI uses.
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function run(args: string[], fetch: typeof globalThis.fetch, env: NodeJS.ProcessEnv = { VITEHUB_CONSOLE_COOKIE: "vitehub_console.session_token=abc" }) {
  const stdout = stream()
  const stderr = stream()
  const exitCode = await runAgentInvocationsCli(args, { env, stderr, stdout }, { fetch, sleep: async () => undefined })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub agent invocations with a deployed Console", () => {
  it("cancels through the Console RPC endpoint with the Console credentials", async () => {
    const host = deployedConsole(() => ({ delivery: "local", id: "ainv_1", outcome: "requested", status: "running" }))
    const result = await run(["cancel", "ainv_1", "--url", "https://agent.example.com"], host.fetch)

    expect(result).toMatchObject({ exitCode: 0, stdout: "ainv_1 cancel requested\n" })
    expect(host.calls).toHaveLength(1)
    const [call] = host.calls
    expect(call!.url).toBe("https://agent.example.com/_vitehub/rpc/__call")
    expect(call!.method).toBe("vitehub:console:invocation")
    expect(call!.input).toEqual({ body: { action: "cancel" }, id: "ainv_1", method: "POST" })
    expect(call!.headers.get("x-vitehub-console")).toBe("1")
    expect(call!.headers.get("cookie")).toBe("vitehub_console.session_token=abc")
  })

  it.each([
    ["https://agent.example.com/_vitehub", "https://agent.example.com/_vitehub/rpc/__call"],
    ["https://agent.example.com/_vitehub/agents/support", "https://agent.example.com/_vitehub/rpc/__call"],
    ["https://example.com/app/", "https://example.com/app/_vitehub/rpc/__call"],
    ["http://localhost:3000/_vitehub", "http://localhost:3000/_vitehub/rpc/__call"],
  ])("resolves the Console RPC endpoint from %s", async (url, endpoint) => {
    const host = deployedConsole(() => ({ invocations: [] }))
    expect((await run(["list", "--url", url], host.fetch)).exitCode).toBe(0)
    expect(host.calls[0]!.url).toBe(endpoint)
  })

  it("keeps a localhost URL without a Console path on the local invocation endpoint", async () => {
    const fetch = vi.fn(async () => Response.json({ invocations: [] }))
    // SAFETY: The mock implements the fetch call shape that the CLI uses.
    expect((await run(["list", "--url", "http://localhost:5173/api/invocations"], fetch as unknown as typeof globalThis.fetch)).exitCode).toBe(0)
    expect(fetch).toHaveBeenCalledWith("http://localhost:5173/api/invocations", expect.anything())
  })

  it.each([
    ["http://agent.example.com", "must use HTTPS"],
    ["https://agent.example.com/?token=secret", "must not contain credentials, a query, or a fragment"],
    ["https://user:secret@agent.example.com", "must not contain credentials, a query, or a fragment"],
  ])("rejects the Console URL %s before it sends a request", async (url, message) => {
    const host = deployedConsole(() => ({ invocations: [] }))
    const result = await run(["list", "--url", url], host.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(message)
    expect(result.stderr).not.toContain("secret")
    expect(host.calls).toHaveLength(0)
  })

  it("filters list results by status across Console pages", async () => {
    const pages = [
      { cursor: "page-2", invocations: [summary("a", "completed"), summary("b", "running")] },
      { invocations: [summary("c", "running"), summary("d", "failed")] },
    ]
    const host = deployedConsole(() => pages.shift())
    const result = await run(["list", "--url", "https://agent.example.com", "--status", "running", "--json"], host.fetch)

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).invocations.map((record: { id: string }) => record.id)).toEqual(["b", "c"])
    expect(host.calls.map(call => call.input.query)).toEqual([{ limit: "100" }, { cursor: "page-2", limit: "100" }])
  })

  it("rejects an unknown status for the Console", async () => {
    const host = deployedConsole(() => ({ invocations: [] }))
    const result = await run(["list", "--url", "https://agent.example.com", "--status", "stuck"], host.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--status must be one of pending, running, completed, failed, cancelled.")
  })

  it("stops listing at the requested limit", async () => {
    const host = deployedConsole(() => ({ cursor: "next", invocations: [summary("a", "running"), summary("b", "running")] }))
    const result = await run(["list", "--url", "https://agent.example.com", "--limit", "2"], host.fetch)
    expect(result.stdout.trim().split("\n")).toHaveLength(2)
    expect(host.calls.map(call => call.input.query)).toEqual([{ limit: "2" }])
  })

  it("tails with the Console observation cursor and prints each observation once", async () => {
    const observation = (sequence: number, name: string) => ({ name, sequence, timestamp: `2026-10-06T10:00:0${sequence}.000Z` })
    const replies = [
      { invocation: summary("ainv_1", "running"), observationCursor: "1-a", observations: [observation(1, "agent.invocation.start")] },
      { appendObservations: true, invocation: summary("ainv_1", "cancelled"), observationCursor: "2-b", observations: [observation(2, "agent.invocation.cancel")] },
    ]
    const host = deployedConsole(() => replies.shift())
    const result = await run(["tail", "ainv_1", "--url", "https://agent.example.com"], host.fetch)

    expect(result.exitCode).toBe(1)
    expect(result.stdout.trim().split("\n").map(line => line.split(" ")[2])).toEqual(["agent.invocation.start", "agent.invocation.cancel"])
    expect(host.calls.map(call => call.input)).toEqual([
      { id: "ainv_1", method: "GET" },
      { id: "ainv_1", method: "GET", query: { observationCount: "1", observationCursor: "1-a" } },
    ])
  })

  it.each([
    [401, { message: "Unauthorized", ok: false, status: 401 }, "Console authentication failed with HTTP 401: Unauthorized. Set VITEHUB_CONSOLE_AUTHORIZATION"],
    [302, undefined, "Console authentication failed with HTTP 302. Set VITEHUB_CONSOLE_AUTHORIZATION"],
    [404, { message: "Invocation not found", ok: false, status: 404 }, "Console request failed with HTTP 404: Invocation not found."],
    [404, "<html>Not found</html>", "https://agent.example.com/ did not answer as a ViteHub Console (HTTP 404)."],
  ])("reports a Console HTTP %s response", async (status, body, message) => {
    const host = deployedConsole(() => new Response(typeof body === "string" ? body : body ? JSON.stringify(body) : null, { status }))
    const result = await run(["show", "ainv_1", "--url", "https://agent.example.com"], host.fetch)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(message)
  })

  it("adds the credential hint to a 403 only when no Console credential is set", async () => {
    const forbidden = () => Response.json({ message: "Forbidden.", ok: false, status: 403 }, { status: 403 })
    const anonymous = await run(["cancel", "ainv_1", "--url", "https://agent.example.com"], deployedConsole(forbidden).fetch, {})
    expect(anonymous.stderr).toBe("Console denied the request with HTTP 403: Forbidden. Set VITEHUB_CONSOLE_AUTHORIZATION, VITEHUB_CONSOLE_COOKIE, or CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.\n")
    const signedIn = await run(["cancel", "ainv_1", "--url", "https://agent.example.com"], deployedConsole(forbidden).fetch)
    expect(signedIn.stderr).toBe("Console denied the request with HTTP 403: Forbidden.\n")
  })
})
