import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { refreshWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

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

const serverId = "replay-test-server"
let rootDir = ""
let devToken = ""

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-replay-cli-"))
  devToken = await refreshWorkspaceDevToken(rootDir, { serverId })
})

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

/** Answers the Agent Dev Loop discovery `GET` with the server root and the token server ID. */
function discovery(init?: RequestInit, root = rootDir): Response | undefined {
  return init?.method === "POST" ? undefined : Response.json({ agents: [{ name: "labeller" }], root, workspaceDevTokenServerId: serverId })
}

function replayFetch(pages: Array<Record<string, unknown>>, root = rootDir) {
  const requests: Array<{ body: Record<string, unknown>, headers: Headers, url: string }> = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const discovered = discovery(init, root)
    if (discovered) return discovered
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
      "--cursor", "abc", "--folder", "inbox", "--label=round-one", "--query", "label=work", "--filter", "label=home",
    ])
    expect(parsed).toMatchObject({ agent: "labeller", channel: "mailbox", cursor: "abc", dryRun: true, force: true, limit: 25, label: "round-one" })
    expect(channelReplayQuery(parsed, querySchema)).toEqual({ folder: "inbox", label: ["work", "home"] })
  })

  it.each(["", "  ", "x".repeat(513)])("rejects an invalid replay label %j", label => {
    expect(() => parseChannelReplayArgs(["--label", label])).toThrow(/label.*non-empty|--label requires/)
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

  it("lists history query flags from the JSON Schema in --help", async () => {
    const stdout = output()
    const { fetcher } = replayFetch([])
    await expect(runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox", "--help"], { env: {}, rootDir, stderr: output(), stdout }, { fetch: fetcher as typeof fetch })).resolves.toBe(0)
    expect(stdout.chunks.join("")).toContain("  --folder <archive|inbox>  required")
    expect(stdout.chunks.join("")).toContain("  --query label=<array>  repeatable")
    expect(channelReplayQueryHelp(undefined)).toEqual(["  This history query has no JSON Schema. Use --filter key=value."])
  })

  it("replays through the dev server in batches and prints a resume cursor at the limit", async () => {
    const stdout = output()
    const { fetcher, requests } = replayFetch([
      { failed: 0, items: [{ key: "m1", status: "completed" }, { key: "m2", reason: "existing", status: "skipped" }], nextCursor: "c2", processed: 1, skipped: 1 },
      { failed: 0, items: [{ key: "m3", status: "completed" }], nextCursor: "c3", processed: 1, skipped: 0 },
    ])
    const code = await runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox", "--limit", "3", "--folder", "inbox"], { env: {}, rootDir, stderr: output(), stdout }, { fetch: fetcher as typeof fetch })

    expect(code).toBe(0)
    expect(requests[0]?.url).toBe("http://localhost:5173/__vitehub/agent/invocation-stream")
    expect(requests[0]?.headers.get("x-vitehub-agent-dev-loop")).toBe("1")
    expect(requests.map(request => request.headers.get(workspaceDevTokenHeader))).toEqual([devToken, devToken, devToken])
    expect(requests.map(request => request.body)).toEqual([
      { agent: "labeller", replay: { channel: "mailbox", describe: true } },
      { agent: "labeller", replay: { channel: "mailbox", limit: 3, query: { folder: "inbox" } } },
      { agent: "labeller", replay: { channel: "mailbox", cursor: "c2", limit: 1, query: { folder: "inbox" } } },
    ])
    expect(stdout.chunks.join("")).toContain("skipped   m2 (existing)")
    expect(stdout.chunks.join("")).toContain("Replayed 2, skipped 1, failed 0.")
    expect(stdout.chunks.join("")).toContain("Continue with --cursor c3")
  })

  it("does not read a token for a dev server outside the project root", async () => {
    const { fetcher, requests } = replayFetch([], "/another-project")
    await runAgentChannelReplayCli(["--agent", "labeller", "--channel", "mailbox"], { env: {}, rootDir, stderr: output(), stdout: output() }, { fetch: fetcher as typeof fetch })
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(request => !request.headers.has(workspaceDevTokenHeader))).toBe(true)
  })

  it("rejects a repeated server pagination cursor", async () => {
    const stderr = output()
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const discovered = discovery(init)
      if (discovered) return discovered
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const replay = (body.replay ?? body) as Record<string, unknown>
      if (replay.describe) return Response.json({ channel: "mailbox", query: querySchema, trigger: "received" })
      return Response.json({
        failed: 0,
        items: [{ key: "m1", status: "completed" }],
        nextCursor: "repeat",
        processed: 1,
        skipped: 0,
      })
    })

    await expect(runAgentChannelReplayCli(
      ["--agent", "labeller", "--channel", "mailbox"],
      { env: {}, rootDir, stderr, stdout: output() },
      { fetch: fetcher as typeof fetch },
    )).resolves.toBe(1)
    expect(stderr.chunks.join("")).toContain("Channel replay returned a repeated pagination cursor.")
  })

  it("posts to the deployed Console with credentials from the environment and fails on item failures", async () => {
    const stdout = output()
    const { fetcher, requests } = replayFetch([
      { failed: 1, items: [{ error: "Invalid input", key: "m1", status: "failed" }], nextCursor: null, processed: 0, skipped: 0 },
    ])
    const code = await runAgentChannelReplayCli(
      ["--agent", "labeller", "--channel", "mailbox", "--url", "https://mail.example.com/app", "--dry-run", "--folder", "inbox"],
      {
        env: {
          CF_ACCESS_CLIENT_ID: "client-id",
          CF_ACCESS_CLIENT_SECRET: "client-secret",
          VITEHUB_CONSOLE_AUTHORIZATION: "Basic abc",
        },
        rootDir,
        stderr: output(),
        stdout,
      },
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
    await expect(runAgentChannelReplayCli(["--agent", "a", "--channel", "c", "--url", "https://example.com"], { env: {}, rootDir, stderr, stdout: output() }, { fetch: fetcher as typeof fetch })).resolves.toBe(1)
    expect(stderr.chunks.join("")).toContain("Console authentication failed with HTTP 302")

    const insecure = output()
    await expect(runAgentChannelReplayCli(["--agent", "a", "--channel", "c", "--url", "http://example.com"], { env: {}, rootDir, stderr: insecure, stdout: output() }, { fetch: fetcher as typeof fetch })).resolves.toBe(1)
    expect(insecure.chunks.join("")).toContain("must use HTTPS")
  })
})
