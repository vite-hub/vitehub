import { describe, expect, it, vi } from "vitest"

import { createRateLimitCliContributor, runRateLimitCli } from "../src/cli.ts"

const rootDir = "/app"

const resetAt = Date.parse("2026-05-22T09:01:00.000Z")

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

function context() {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd: rootDir, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" } as NodeJS.ProcessEnv, rootDir, stderr, stdout }, stderr, stdout }
}

/**
 * A fake app: it answers the operation RPC. A result is the value of the operation. With `status`, the result is an
 * error body, `{ error: { code?, message } }`, which the RPC reports as the failure fields.
 */
function devServer(result: unknown, init: { status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, _request?: RequestInit) => {
    const status = init.status ?? 200
    if (status < 400) return Response.json({ ok: true, value: result }, { status })
    const error = (result as { error: { code?: string, message: string } }).error
    return Response.json({ ok: false, code: error.code ?? "RATE_LIMIT_FAILED", message: error.message, status }, { status })
  })
}

/** The operation and input that a command sent. */
function sentCall(fetch: ReturnType<typeof devServer>) {
  const request = fetch.mock.calls[0]?.[1]
  return { body: JSON.parse(String(request?.body)) as { input: unknown, operation: string }, headers: new Headers(request?.headers), method: request?.method }
}

const known = {
  counters: [{ limit: 5, remaining: 3, resetAt, used: 2, window: "1m", windowMs: 60_000 }],
  key: "192.0.2.1",
  name: "login",
  provider: "memory",
  scope: "process",
  status: "known",
}

const cloudflareReason = "The Cloudflare Rate Limiting binding exposes only limit(), which consumes a token. It cannot read or reset a counter."

describe("Rate Limit review regressions", () => {
  it.each(["2147483648", "4294967296"])("rejects timeout %s before the call", async timeout => {
    const output = context()
    const fetch = vi.fn()
    await expect(runRateLimitCli(["peek", "login", "key", "--timeout", timeout, "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("at most 2147483647")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ flags: [] }, { flags: ["--json"] }])("reports malformed counters with flags %j", async ({ flags }) => {
    const output = context()
    await expect(runRateLimitCli(["peek", "login", "key", ...flags], output.context, { fetch: devServer({ ...known, counters: [{}] }) })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).toContain("invalid result")
  })

  it.each(["-1", "--json"])("accepts dash-prefixed key %s after --", async (key) => {
    const output = context()
    const fetch = devServer({ ...known, key })
    await expect(runRateLimitCli(["peek", "login", "--json", "--", key], output.context, { fetch })).resolves.toBe(0)
    expect(sentCall(fetch).body).toEqual({ input: { key, name: "login" }, operation: "rate-limit.peek" })
  })

  it.each([false, true])("redacts credentials in argument failures with JSON %s", async json => {
    for (const argument of ["--token=sk_live_secret", "--api-key=hidden-key", "token=hidden-token", "Bearer hidden-bearer", "http://user:hidden-password@host"]) {
      const output = context()
      const fetch = vi.fn()
      await expect(runRateLimitCli(["peek", "login", "key", argument, ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
      const diagnostic = output.stdout.output() + output.stderr.output()
      expect(diagnostic).not.toContain("sk_live_secret")
      expect(diagnostic).not.toContain("hidden-")
      expect(diagnostic).toContain("[redacted]")
      if (json) { expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message"); expect(output.stderr.output()).toBe("") }
      else expect(output.stdout.output()).toBe("")
      expect(fetch).not.toHaveBeenCalled()
    }
  })

  it("redacts credentials in unknown command names", async () => {
    const output = context()
    const fetch = vi.fn()
    await expect(runRateLimitCli(["token=hidden-command"], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("token=[redacted]")
    expect(output.stderr.output()).not.toContain("hidden-command")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([false, true])("redacts provider errors and preserves the error code with JSON %s", async json => {
    const output = context()
    const fetch = devServer({ error: { code: "PROVIDER_OFFLINE", message: "token=hidden-provider" } }, { status: 500 })
    await expect(runRateLimitCli(["peek", "login", "key", ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).not.toContain("hidden-provider")
    if (json) expect(JSON.parse(output.stdout.output())).toEqual({ error: { code: "PROVIDER_OFFLINE", message: "token=[redacted]" } })
    else expect(output.stderr.output()).toBe("token=[redacted]\n")
  })

  it("applies the request timeout", async () => {
    const output = context()
    const fetch = vi.fn((_url: string | URL | Request, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
    }))
    await expect(runRateLimitCli(["peek", "login", "key", "--json", "--timeout", "10"], output.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("says to start the dev server when none runs", async () => {
    const output = context()
    output.context.env = {}
    const fetch = vi.fn()
    await expect(runRateLimitCli(["peek", "login", "key"], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("No dev server is running for /app.")
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("vitehub rate-limit", () => {
  it("prints the counter of one key as a table and as JSON", async () => {
    const human = context()
    const fetch = devServer(known)

    await expect(runRateLimitCli(["peek", "login", "192.0.2.1", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe([
      "Rate Limit login, key 192.0.2.1",
      "Provider: memory",
      "Scope: process. The counter exists only in this server process.",
      "LIMIT  WINDOW  USED  REMAINING  RESETS AT",
      "5      1m      2     3          2026-05-22T09:01:00.000Z",
      "",
    ].join("\n"))
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4321/_vitehub/rpc/__call")
    const sent = sentCall(fetch)
    expect(sent).toMatchObject({ body: { input: { key: "192.0.2.1", name: "login" }, operation: "rate-limit.peek" }, method: "POST" })
    expect(sent.headers.get("x-vitehub-console")).toBe("1")

    const json = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1", "--json"], json.context, { fetch: devServer(known) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual(known)
  })

  it("prints an unused counter and a reset", async () => {
    const unused = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1"], unused.context, {
      fetch: devServer({ key: "192.0.2.1", name: "login", provider: "memory", reason: "No request used this Rate Limit.", status: "unused" }),
    })).resolves.toBe(0)
    expect(unused.stdout.output()).toBe("Rate Limit login, key 192.0.2.1\nProvider: memory\nNo counter: No request used this Rate Limit.\n")

    const reset = context()
    const fetch = devServer({ key: "192.0.2.1", name: "login", provider: "memory", scope: "process", status: "reset" })
    await expect(runRateLimitCli(["reset", "login", "192.0.2.1"], reset.context, { fetch })).resolves.toBe(0)
    expect(sentCall(fetch).body).toEqual({ input: { key: "192.0.2.1", name: "login" }, operation: "rate-limit.reset" })
    expect(reset.stdout.output()).toBe([
      "Reset Rate Limit login for key 192.0.2.1.",
      "Provider: memory",
      "Scope: process. The counter exists only in this server process.",
      "",
    ].join("\n"))
  })

  it("exits with 1 when the provider cannot read or reset the counter", async () => {
    const unsupported = { key: "192.0.2.1", name: "login", provider: "cloudflare", reason: cloudflareReason, status: "unsupported" }
    const peek = context()
    await expect(runRateLimitCli(["peek", "login", "192.0.2.1"], peek.context, { fetch: devServer(unsupported) })).resolves.toBe(1)
    expect(peek.stdout.output()).toBe(`Rate Limit login, key 192.0.2.1\nProvider: cloudflare\nCounter unknown: ${cloudflareReason}\n`)

    const reset = context()
    await expect(runRateLimitCli(["reset", "login", "192.0.2.1"], reset.context, { fetch: devServer(unsupported) })).resolves.toBe(1)
    expect(reset.stdout.output()).toBe(`Rate Limit login, key 192.0.2.1\nProvider: cloudflare\nNot reset: ${cloudflareReason}\n`)

    const json = context()
    await expect(runRateLimitCli(["reset", "login", "192.0.2.1", "--json"], json.context, { fetch: devServer(unsupported) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(unsupported)
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { message: "[vitehub] Rate Limit key must be a non-empty string." } }
    const human = context()
    await expect(runRateLimitCli(["peek", "login", "x"], human.context, { fetch: devServer(failure, { status: 500 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("[vitehub] Rate Limit key must be a non-empty string.\n")

    const json = context()
    await expect(runRateLimitCli(["peek", "login", "x", "--json"], json.context, { fetch: devServer(failure, { status: 500 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual({ error: { code: "RATE_LIMIT_FAILED", message: failure.error.message } })
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const missingId = context()
    await expect(runRateLimitCli(["peek"], missingId.context, { fetch })).resolves.toBe(1)
    expect(missingId.stderr.output()).toContain("Missing Rate Limit ID.")
    expect(missingId.stderr.output()).toContain("Usage: vitehub rate-limit peek <id> <key> [--json] [--url <url>]")
    const missingKey = context()
    await expect(runRateLimitCli(["reset", "login"], missingKey.context, { fetch })).resolves.toBe(1)
    expect(missingKey.stderr.output()).toContain("Missing Rate Limit key.")
    const extra = context()
    await expect(runRateLimitCli(["peek", "login", "a", "b"], extra.context, { fetch })).resolves.toBe(1)
    expect(extra.stderr.output()).toContain("Unexpected argument: b.")
    const unknown = context()
    await expect(runRateLimitCli(["peek", "login", "a", "--limit", "2"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toContain("Unknown option: --limit.")
    const command = context()
    await expect(runRateLimitCli(["consume", "login", "a"], command.context, { fetch })).resolves.toBe(1)
    expect(command.stderr.output()).toBe("Unknown rate-limit command: consume\nCommands: peek, reset\n")
    const help = context()
    await expect(runRateLimitCli(["reset", "--help"], help.context, { fetch })).resolves.toBe(0)
    expect(help.stdout.output()).toContain("Usage: vitehub rate-limit reset <id> <key>")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command", () => {
    const [namespace] = createRateLimitCliContributor().namespaces
    expect(namespace?.name).toBe("rate-limit")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["peek", "reset"])
  })
})
