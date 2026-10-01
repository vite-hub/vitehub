import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"

import { channelReplayQuery, channelReplayQueryHelp, parseChannelReplayArgs, runAgentChannelReplayCli } from "../src/internal/channel-replay-cli.ts"

const querySchema = {
  properties: {
    folder: { enum: ["archive", "inbox"] },
    label: { items: { type: "string" }, type: "array" },
  },
  required: ["folder"],
  type: "object",
}

function output() {
  const chunks: string[] = []
  return { chunks, write: (chunk: string | Uint8Array) => chunks.push(String(chunk)) }
}

function replayFetch(pages: Array<Record<string, unknown>>) {
  const requests: Array<{ body: Record<string, unknown>, headers: Headers, url: string }> = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ body, headers: new Headers(init?.headers), url: String(url) })
    const replay = (body.replay ?? body) as Record<string, unknown>
    if (replay.describe) return Response.json({ channel: "mailbox", query: querySchema, trigger: "received" })
    return Response.json(pages.shift() ?? { failed: 0, items: [], nextCursor: null, processed: 0, skipped: 0 })
  })
  return { fetcher, requests }
}

describe("vitehub channels replay", () => {
  it("parses options, typed query flags, and filters", () => {
    const parsed = parseChannelReplayArgs([
      "--agent", "labeller", "--channel=mailbox", "--dry-run", "--force", "--limit", "25",
      "--cursor", "abc", "--folder", "inbox", "--label=work", "--filter", "label=home",
    ])
    expect(parsed).toMatchObject({ agent: "labeller", channel: "mailbox", cursor: "abc", dryRun: true, force: true, limit: 25 })
    expect(channelReplayQuery(parsed, querySchema)).toEqual({ folder: "inbox", label: ["work", "home"] })
  })

  it.each([
    ["typed", ["--label", "work"]],
    ["filter", ["--filter", "label=work"]],
  ] as const)("sends a single %s array value as an array", (_mode, args) => {
    expect(channelReplayQuery(parseChannelReplayArgs([...args, "--folder", "inbox"]), querySchema)).toEqual({ folder: "inbox", label: ["work"] })
  })

  it("preserves scalar, repeated scalar, and schema-free filter values", () => {
    expect(channelReplayQuery(parseChannelReplayArgs(["--folder", "inbox"]), querySchema)).toEqual({ folder: "inbox" })
    expect(channelReplayQuery(parseChannelReplayArgs(["--folder", "inbox", "--filter", "folder=archive"]), querySchema)).toEqual({ folder: ["inbox", "archive"] })
    expect(channelReplayQuery(parseChannelReplayArgs(["--filter", "label=work"]), undefined)).toEqual({ label: "work" })
  })

  it.each([
    { args: ["--label", "work"], label: ["work"], code: 0 },
    { args: ["--filter", "label=work"], label: ["work"], code: 0 },
    { args: ["--label", "work", "--filter", "label=home"], label: ["work", "home"], code: 0 },
    { args: ["--label", "work", "--filter", "folder=archive"], label: ["work"], code: 1 },
    { args: ["--filter", "label=work"], label: "work", code: 0, noSchema: true },
  ])("validates posted query $args with the Collection schema", async ({ args, label, code, noSchema }) => {
    const requests: unknown[] = []
    const schema = v.object({ folder: v.string(), label: noSchema ? v.string() : v.array(v.string()) })
    const stderr = output()
    const fetcher: typeof fetch = async (_url, init) => {
      const { replay } = v.parse(v.object({ replay: v.object({ describe: v.optional(v.boolean()), query: v.optional(v.unknown()) }) }), JSON.parse(String(init?.body)))
      if (replay.describe) return Response.json({ channel: "mailbox", query: noSchema ? undefined : querySchema, trigger: "received" })
      requests.push(replay.query)
      if (!v.safeParse(schema, replay.query).success) return Response.json({ message: "Invalid Collection query" }, { status: 400 })
      return Response.json({ failed: 0, items: [], nextCursor: null, processed: 0, skipped: 0 })
    }
    expect(await runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox", "--filter", "folder=inbox", ...args], { env: {}, stderr, stdout: output() }, { fetch: fetcher })).toBe(code)
    expect(requests).toEqual([{ folder: code === 1 ? ["inbox", "archive"] : "inbox", label }])
    if (code === 1) expect(stderr.chunks.join("")).toContain("Invalid Collection query")
  })

  it("rejects malformed options and query keys outside the schema", () => {
    expect(() => parseChannelReplayArgs(["--limit", "0"])).toThrow(/positive integer/)
    expect(() => parseChannelReplayArgs(["--filter", "=x"])).toThrow(/key=value/)
    expect(() => parseChannelReplayArgs(["--folder"])).toThrow(/requires a value/)
    expect(() => parseChannelReplayArgs(["mailbox"])).toThrow(/Unexpected/)
    expect(() => channelReplayQuery(parseChannelReplayArgs(["--color", "red"]), querySchema)).toThrow(/History query keys: folder, label/)
    expect(() => channelReplayQuery(parseChannelReplayArgs(["--color", "red"]), undefined)).toThrow(/use --filter key=value/)
    expect(channelReplayQuery(parseChannelReplayArgs(["--filter", "color=red"]), undefined)).toEqual({ color: "red" })
  })

  it("keeps prototype-named query keys as own values", () => {
    const query = channelReplayQuery(
      parseChannelReplayArgs(["--__proto__", "proto", "--filter", "__proto__=again", "--constructor", "ctor", "--toString", "string"]),
      { properties: { ["__proto__"]: {}, constructor: {}, toString: {} } },
    )

    expect(Object.hasOwn(query, "__proto__")).toBe(true)
    expect(query["__proto__"]).toEqual(["proto", "again"])
    expect(query.constructor).toBe("ctor")
    expect(query.toString).toBe("string")
  })

  it.each(["agent", "channel", "cursor", "filter", "limit", "server", "url", "dry-run", "force", "help"])("uses --filter for the reserved query key %s", (name) => {
    expect(channelReplayQueryHelp({ properties: { [name]: { type: "string" } } })).toEqual([`  --filter ${name}=<string>`])
    expect(channelReplayQuery(parseChannelReplayArgs(["--filter", `${name}=value`]), { properties: { [name]: { type: "string" } } })).toEqual({ [name]: "value" })
  })

  it.each([["--label", "work"], ["--filter", "label=work"], ["--label", "work", "--filter", "label=personal"]])("sends array query values as arrays for %j", async (...args) => {
    const stderr = output()
    const { fetcher, requests } = replayFetch([{ failed: 0, items: [], nextCursor: null, processed: 0, skipped: 0 }])
    expect(await runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox", ...args], { env: {}, stderr, stdout: output() }, { fetch: fetcher as typeof fetch })).toBe(0)
    expect(requests[1]?.body).toMatchObject({ replay: { query: { label: args.length === 2 ? ["work"] : ["work", "personal"] } } })
    expect(stderr.chunks).toEqual([])
  })

  it("lists history query flags from the JSON Schema in --help", async () => {
    const stdout = output()
    const { fetcher } = replayFetch([])
    await expect(runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox", "--help"], { env: {}, stderr: output(), stdout }, { fetch: fetcher as typeof fetch })).resolves.toBe(0)
    expect(stdout.chunks.join("")).toContain("  --folder <archive|inbox>  required")
    expect(stdout.chunks.join("")).toContain("  --label <array>  repeatable")
    expect(channelReplayQueryHelp(undefined)).toEqual(["  This history query has no JSON Schema. Use --filter key=value."])
  })

  it("replays through the dev server in batches and prints a resume cursor at the limit", async () => {
    const stdout = output()
    const { fetcher, requests } = replayFetch([
      { failed: 0, items: [{ key: "m1", status: "completed" }, { key: "m2", reason: "existing", status: "skipped" }], nextCursor: "c2", processed: 1, skipped: 1 },
      { failed: 0, items: [{ key: "m3", status: "completed" }], nextCursor: "c3", processed: 1, skipped: 0 },
    ])
    const code = await runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox", "--limit", "3", "--folder", "inbox"], { env: {}, stderr: output(), stdout }, { fetch: fetcher as typeof fetch })

    expect(code).toBe(0)
    expect(requests[0]?.url).toBe("http://localhost:5173/__vitehub/agent/invocation-stream")
    expect(requests[0]?.headers.get("x-vitehub-agent-dev-loop")).toBe("1")
    expect(requests.map(request => request.body)).toEqual([
      { agent: "labeller", replay: { channel: "mailbox", describe: true } },
      { agent: "labeller", replay: { channel: "mailbox", limit: 3, query: { folder: "inbox" } } },
      { agent: "labeller", replay: { channel: "mailbox", cursor: "c2", limit: 1, query: { folder: "inbox" } } },
    ])
    expect(stdout.chunks.join("")).toContain("skipped   m2 (existing)")
    expect(stdout.chunks.join("")).toContain("Replayed 2, skipped 1, failed 0.")
    expect(stdout.chunks.join("")).toContain("Continue with --cursor c3")
  })

  it("forwards Cloudflare Access service credentials only to a remote Console", async () => {
    const env = { CF_ACCESS_CLIENT_ID: "service-id", CF_ACCESS_CLIENT_SECRET: "service-secret" }
    for (const remote of [false, true]) {
      const { fetcher, requests } = replayFetch([{ failed: 0, items: [], nextCursor: null, processed: 0, skipped: 0 }])
      const args = ["--agent", "labeller", "--channel", "mailbox", ...(remote ? ["--url", "https://mail.example.com/app"] : [])]
      expect(await runAgentChannelReplayCli(args, { env, stderr: output(), stdout: output() }, { fetch: fetcher as typeof fetch })).toBe(0)
      for (const request of requests) {
        expect(request.headers.get("cf-access-client-id")).toBe(remote ? "service-id" : null)
        expect(request.headers.get("cf-access-client-secret")).toBe(remote ? "service-secret" : null)
      }
    }
    const stdout = output()
    await runAgentChannelReplayCli(["--help"], { env: {}, stderr: output(), stdout })
    expect(stdout.chunks.join("")).toContain("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET")
  })

  it("posts to the deployed Console with credentials from the environment and fails on item failures", async () => {
    const stdout = output()
    const { fetcher, requests } = replayFetch([
      { failed: 1, items: [{ error: "Invalid input", key: "m1", status: "failed" }], nextCursor: null, processed: 0, skipped: 0 },
    ])
    const code = await runAgentChannelReplayCli(
      ["--agent", "labeller", "--channel", "mailbox", "--url", "https://mail.example.com/app", "--dry-run", "--folder", "inbox"],
      { env: { VITEHUB_CONSOLE_AUTHORIZATION: "Basic abc", CF_ACCESS_CLIENT_ID: "client-id", CF_ACCESS_CLIENT_SECRET: "client-secret" }, stderr: output(), stdout },
      { fetch: fetcher as typeof fetch },
    )

    expect(code).toBe(1)
    expect(requests[1]).toMatchObject({
      body: { agent: "labeller", channel: "mailbox", dryRun: true, limit: 10, query: { folder: "inbox" } },
      url: "https://mail.example.com/app/_vitehub/channels/replay",
    })
    expect(requests[1]?.headers.get("authorization")).toBe("Basic abc")
    expect(requests[1]?.headers.get("cf-access-client-id")).toBe("client-id")
    expect(requests[1]?.headers.get("cf-access-client-secret")).toBe("client-secret")
    expect(stdout.chunks.join("")).toContain("failed    m1: Invalid input")
    expect(stdout.chunks.join("")).toContain("Dry run: Channel message writes were recorded, not sent.")
  })

  it("reports Console authentication failures and rejects plain HTTP deployments", async () => {
    const stderr = output()
    const fetcher = vi.fn(async () => new Response(null, { headers: { location: "/_vitehub/sign-in" }, status: 302 }))
    await expect(runAgentChannelReplayCli(["--agent", "a", "--channel", "c", "--url", "https://example.com"], { env: {}, stderr, stdout: output() }, { fetch: fetcher as typeof fetch })).resolves.toBe(1)
    expect(stderr.chunks.join("")).toContain("Console authentication failed with HTTP 302")

    const insecure = output()
    await expect(runAgentChannelReplayCli(["--agent", "a", "--channel", "c", "--url", "http://example.com"], { env: {}, stderr: insecure, stdout: output() }, { fetch: fetcher as typeof fetch })).resolves.toBe(1)
    expect(insecure.chunks.join("")).toContain("must use HTTPS")
  })
})
