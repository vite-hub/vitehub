import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MockLanguageModelV4 } from "ai/test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { runMcpEval } from "../src/eval.ts"
import { defineMcpTool } from "../src/index.ts"
import { createMcpHandler } from "../src/runtime.ts"

import type { H3Event } from "h3"
import type { McpEvalCase } from "../src/eval.ts"

const deleted: string[] = []
const searchText = "Queue retries: see /docs/queue#retries. ".repeat(10)

const handler = createMcpHandler({
  name: "docs",
  route: "/mcp",
  instructions: "Search the docs before you answer.",
  tools: {
    "search-docs": defineMcpTool({
      description: "Search the docs.",
      input: z.strictObject({ query: z.string() }),
      annotations: { readOnlyHint: true },
      handler: () => searchText,
    }),
    "delete-page": defineMcpTool({
      description: "Delete a docs page.",
      input: z.object({ path: z.string() }),
      handler: ({ path }) => {
        deleted.push(path)
        return "deleted"
      },
    }),
  },
})

async function serve(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init)
  // SAFETY: The handler reads only `req` and `url` and passes the event to the tools.
  return await handler({ req, url: new URL(req.url) } as unknown as H3Event)
}

const usage = { inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } }

function docsModel(followUpError?: Error) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      if (prompt.at(-1)?.role === "tool") {
        if (followUpError) throw followUpError
        return { content: [{ type: "text", text: "Queue retries are in /docs/queue." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }
      }
      return {
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "search-docs", input: JSON.stringify({ query: "queue retries" }) },
          { type: "tool-call", toolCallId: "call-2", toolName: "delete-page", input: JSON.stringify({ path: "/docs/queue" }) },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage,
        warnings: [],
      }
    },
  })
}

const cases: McpEvalCase[] = [
  {
    id: "queue-retries",
    kind: "bad",
    origin: { type: "issue", url: "https://github.com/vite-hub/vitehub/issues/1" },
    prompt: "How do Queue retries work?",
    expect: { calls: [{ tool: "search-docs", args: { query: "~retries" } }], finalTextMust: ["/docs/queue"] },
  },
  {
    id: "say-hello",
    kind: "control",
    origin: { type: "synthetic" },
    prompt: "Say hello.",
    expect: { maxCalls: 0 },
  },
]

let out: string

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "mcp-eval-"))
  deleted.length = 0
  vi.stubGlobal("fetch", serve)
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  process.exitCode = undefined
  await rm(out, { force: true, recursive: true })
})

describe("runMcpEval", () => {
  it("rejects redirects for MCP requests with custom authentication", async () => {
    const fetchMcp = vi.fn(serve)
    vi.stubGlobal("fetch", fetchMcp)

    const report = await runMcpEval({ server: { url: "https://docs.example.com/mcp", headers: { "x-api-key": "test-key" } }, cases, models: {}, argv: ["--dry-run"] })

    expect(report.exitCode).toBe(0)
    expect(fetchMcp).toHaveBeenCalled()
    for (const [input, init] of fetchMcp.mock.calls) {
      const request = new Request(input, init)
      expect(request.headers.get("x-api-key")).toBe("test-key")
      expect(request.redirect).toBe("error")
    }
  })

  it("falls back to legacy initialization when discovery reports a legacy version", async () => {
    const methods: string[] = []
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const rpc = await request.clone().json()
      if (!rpc || typeof rpc !== "object" || !("method" in rpc) || typeof rpc.method !== "string") throw new Error("Expected an MCP request")
      methods.push(rpc.method)
      if (rpc.method === "server/discover") {
        if (!("id" in rpc)) throw new Error("Expected a request id")
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2025-11-25"] } } })
      }
      return serve(request)
    })

    const report = await runMcpEval({ server: { url: "https://docs.example.com/mcp" }, cases, models: {}, argv: ["--dry-run"] })

    expect(report.exitCode).toBe(0)
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"])
  })

  it("runs read-only tools, records the other calls without running them, and writes the results", async () => {
    const model = docsModel()
    const report = await runMcpEval({ server: { url: "https://docs.example.com/mcp" }, cases, models: { mock: model }, argv: ["--out", out] })

    expect(deleted).toEqual([])
    expect(report.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
    expect(report.cases.map(result => [result.id, result.status, result.samples.length, result.passRate])).toEqual([
      ["queue-retries", "pass", 2, 1],
      ["say-hello", "fail", 2, 0],
    ])
    expect(model.doGenerateCalls[0]?.prompt[0]).toEqual({ role: "system", content: "Search the docs before you answer." })

    const rows = (await readFile(join(out, "results.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      id: "queue-retries",
      kind: "bad",
      model: "mock",
      sample: 1,
      pass: true,
      finalText: "Queue retries are in /docs/queue.",
      usage: { input: 200, output: 20, cacheRead: 40 },
      calls: [
        { tool: "search-docs", args: { query: "queue retries" }, executed: true, resultChars: searchText.length },
        { tool: "delete-page", args: { path: "/docs/queue" }, executed: false, resultChars: "not executed: tool is not read-only".length },
      ],
    })
    expect(rows[0].steps).toHaveLength(2)
    expect(rows[2].checks).toEqual([{ name: "maxCalls", pass: false, reason: "2 call(s), the limit is 0." }])

    const tools = JSON.parse(await readFile(join(out, "tools.json"), "utf8"))
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual(["search-docs", "delete-page"])
    const summary = await readFile(join(out, "summary.md"), "utf8")
    expect(summary).toContain("| queue-retries | bad | 2 | 100% | pass |")
    expect(summary).toContain("| control | 0 | 1 | 0 | 0 |")
    expect(summary).toContain("- Tool calls: 8")
  })

  it("checks the cases against the live tool list in a dry run, with no model call", async () => {
    const model = docsModel()
    const check = vi.fn(() => [{ tool: "delete-page", message: "A tool that deletes needs destructiveHint." }])
    const report = await runMcpEval({
      server: { url: "https://docs.example.com/mcp" },
      cases: [{ ...cases[0]!, expect: { calls: [{ tool: "search-docs", args: { q: "retries" } }], notCalls: ["remove-page"] } }],
      models: { mock: model },
      check,
      argv: ["--dry-run"],
    })

    expect(model.doGenerateCalls).toHaveLength(0)
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.arrayContaining([expect.objectContaining({ name: "delete-page" })]) }))
    expect(report.findings).toEqual([{ tool: "delete-page", message: "A tool that deletes needs destructiveHint." }])
    expect(report.problems).toEqual([
      "queue-retries: \"q\" is not in the input schema of \"search-docs\".",
      "queue-retries: expect.notCalls names \"remove-page\", which is not in tools/list.",
    ])
    expect(report.exitCode).toBe(1)
  })

  it("runs the chosen case with a fixed number of samples", async () => {
    const report = await runMcpEval({ server: { url: "https://docs.example.com/mcp" }, cases, models: { mock: docsModel() }, argv: ["--out", out, "--case", "queue-retries", "--samples", "1"] })

    expect(report.cases.map(result => [result.id, result.samples.length])).toEqual([["queue-retries", 1]])
    expect(report.exitCode).toBe(0)
  })

  it("preserves completed tool calls and charges usage when a later step fails", async () => {
    const model = docsModel(new Error("Provider unavailable"))
    const report = await runMcpEval({ server: { url: "https://docs.example.com/mcp" }, cases, models: { mock: model }, argv: ["--out", out, "--case", "queue-retries", "--samples", "3", "--max-tokens", "150"] })

    expect(model.doGenerateCalls).toHaveLength(3)
    const samples = report.cases[0]?.samples
    expect(samples).toHaveLength(2)
    expect(samples?.[0]).toMatchObject({ error: "Provider unavailable", pass: false, usage: { input: 100, output: 10, cacheRead: 20 }, calls: [{ tool: "search-docs", executed: true }, { tool: "delete-page", executed: false }] })
    expect(samples?.[0]?.steps).toHaveLength(1)
    expect(report.cases[0]?.passRate).toBe(0)
    expect(report.exitCode).toBe(1)
  })

  it("reports an incomplete case when the budget skips a required sample", async () => {
    const report = await runMcpEval({ server: { url: "https://docs.example.com/mcp" }, cases, models: { mock: docsModel() }, argv: ["--out", out, "--case", "queue-retries", "--samples", "2", "--max-tokens", "150"] })

    expect(report.cases[0]).toMatchObject({ status: "incomplete", passRate: 1, samples: [{ pass: true }] })
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain("| queue-retries | bad | 1 | 100% | incomplete |")
    expect(report.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
  })

  it("does not pass when the budget cuts off the last sample's tool follow-up", async () => {
    const model = docsModel()
    const report = await runMcpEval({
      server: { url: "https://docs.example.com/mcp" }, cases: [{ ...cases[0]!, expect: { maxCalls: 2 } }], models: { mock: model },
      argv: ["--out", out, "--samples", "1", "--max-tokens", "100"],
    })

    expect(model.doGenerateCalls).toHaveLength(1)
    expect(report.cases[0]?.status).toBe("incomplete")
    expect(report.exitCode).toBe(1)
  })
})
