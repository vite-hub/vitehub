import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/cli.ts"
import { refreshWorkspaceDevToken } from "@vite-hub/workspace/server"
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

interface Call {
  method: string
  operation?: string
  url: string
}

/**
 * A local app. `console` answers the Console RPC at `<app>/_vitehub/rpc`. Without it, the app has no Console, as with a
 * standalone `hubAgent()` dev server, and only the old local endpoints answer.
 */
function localApp(options: { console?: (operation: string) => unknown, root?: string, serverId?: string } = {}) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    if (url.endsWith("/_vitehub/rpc") && method === "POST") {
      const operation = operationRpcRequest(init?.body).operation
      calls.push({ method, operation, url })
      if (!options.console) return new Response("<!doctype html><title>Not found</title>", { headers: { "content-type": "text/html" }, status: 404 })
      return operationRpcResponse(init?.body, { ok: true, value: options.console(operation) })
    }
    calls.push({ method, url })
    if (url.includes("/__vitehub/agent/invocations/dev")) {
      return Response.json(method === "POST" ? { id: "ainv_1", outcome: "requested" } : { root: options.root, runtime: "nitro", workspaceDevTokenServerId: options.serverId })
    }
    if (url.includes("/api/invocations")) return Response.json({ invocations: [] })
    return new Response("<!doctype html><title>App</title>", { headers: { "content-type": "text/html" } })
  })
  // SAFETY: The mock implements the fetch call shape that the CLI uses.
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function run(args: string[], fetch: typeof globalThis.fetch, rootDir = process.cwd()) {
  const stdout = stream()
  const stderr = stream()
  const exitCode = await runAgentInvocationsCli(args, { env: {}, rootDir, stderr, stdout }, { fetch, sleep: async () => undefined })
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub agent invocations --url is the app URL", () => {
  it.each([
    ["http://localhost:3000", "http://localhost:3000/_vitehub/rpc"],
    ["http://localhost:3000/portal/", "http://localhost:3000/portal/_vitehub/rpc"],
  ])("lists through the Console of the local app at %s, like the generated commands", async (url, endpoint) => {
    const app = localApp({ console: () => ({ invocations: [] }) })
    const result = await run(["list", "--url", url], app.fetch)

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" })
    expect(app.calls).toEqual([{ method: "POST", operation: "invocations.list", url: endpoint }])
  })

  it("cancels through the Console of the local app", async () => {
    const app = localApp({ console: () => ({ delivery: "local", id: "ainv_1", outcome: "requested", status: "running" }) })
    const result = await run(["cancel", "ainv_1", "--url", "http://localhost:3000"], app.fetch)

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ainv_1 cancel requested\n" })
    expect(app.calls).toEqual([{ method: "POST", operation: "invocations.cancel", url: "http://localhost:3000/_vitehub/rpc" }])
  })

  it.each(["http://localhost:3000/_vitehub", "https://agent.example.com/_vitehub/agents/support"])("still takes the Console URL %s for one minor version, with a deprecation diagnostic", async (url) => {
    const app = localApp({ console: () => ({ invocations: [] }) })
    const result = await run(["list", "--url", url], app.fetch)

    expect(result.exitCode).toBe(0)
    expect(app.calls.map(call => call.url)).toEqual([`${new URL(url).origin}/_vitehub/rpc`])
    expect(result.stderr).toContain("AGENT_R1053")
    expect(result.stderr).toContain(`--url ${new URL(url).origin}`)
  })

  it("still reads a local invocation endpoint for one minor version, with a deprecation diagnostic", async () => {
    const app = localApp()
    const result = await run(["list", "--url", "http://localhost:5173/api/invocations"], app.fetch)

    expect(result.exitCode, result.stderr).toBe(0)
    expect(app.calls.at(-1)).toEqual({ method: "GET", url: "http://localhost:5173/api/invocations" })
    expect(result.stderr).toContain("AGENT_R1053")
  })

  it("still cancels on a dev server without a Console for one minor version, with a deprecation diagnostic", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-url-"))
    const serverId = `${process.pid + 1}:5173`
    await refreshWorkspaceDevToken(rootDir, { serverId })
    try {
      const app = localApp({ root: rootDir, serverId })
      const result = await run(["cancel", "ainv_1", "--url", "http://localhost:5173"], app.fetch, rootDir)

      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stdout).toBe("ainv_1 cancel requested\n")
      expect(app.calls.at(-1)).toEqual({ method: "POST", url: "http://localhost:5173/__vitehub/agent/invocations/dev" })
      expect(result.stderr).toContain("AGENT_R1053")
      expect(result.stderr).toContain("--server http://localhost:5173")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
