import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

  it.each([
    ["http://localhost:3000/_vitehub", "http://localhost:3000"],
    ["https://agent.example.com/portal/_vitehub/agents/support", "https://agent.example.com/portal/"],
  ])("refuses the Console URL %s and names the app URL", async (url, app) => {
    const fetch = localApp({ console: () => ({ invocations: [] }) })
    const result = await run(["list", "--url", url], fetch.fetch)

    expect(result.exitCode).toBe(1)
    expect(fetch.calls).toEqual([])
    expect(result.stderr).toContain(`--url is the app URL, not the Console URL. Pass --url ${app}.`)
  })

  it("refuses a local app without a Console for reads", async () => {
    const app = localApp()
    const result = await run(["list", "--url", "http://localhost:5173/api/invocations"], app.fetch)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("did not answer as a ViteHub Console")
  })

  it("fails for the removed --server and names --url", async () => {
    const app = localApp()
    const result = await run(["cancel", "ainv_1", "--server", "http://localhost:5173"], app.fetch)

    expect(result.exitCode).toBe(1)
    expect(app.calls).toEqual([])
    expect(result.stderr).toContain("--server is now --url")
  })

  it.each([false, true])("cancels through the dev endpoint (discovered: %s)", async discovered => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-url-"))
    const serverId = `${process.pid + 1}:5173`
    await refreshWorkspaceDevToken(rootDir, { serverId })
    try {
      if (discovered) {
        await mkdir(join(rootDir, ".vitehub"))
        await writeFile(join(rootDir, ".vitehub/dev-server.json"), JSON.stringify({ root: rootDir, url: "http://localhost:5173/" }))
      }
      const app = localApp({ root: rootDir, serverId, ...(discovered ? { console: () => { throw new Error("The Console must not be called") } } : {}) })
      const result = await run(["cancel", "ainv_1", "--url", "http://localhost:5173"], app.fetch, rootDir)

      expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ainv_1 cancel requested\n" })
      expect(app.calls.at(-1)).toEqual({ method: "POST", url: "http://localhost:5173/__vitehub/agent/invocations/dev" })
      expect(app.calls.some(call => call.url.endsWith("/_vitehub/rpc"))).toBe(!discovered)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})

describe("vitehub agent invocations without --url", () => {
  async function project(devServer?: string) {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-invocations-dev-server-"))
    if (devServer) {
      await mkdir(join(rootDir, ".vitehub"), { recursive: true })
      await writeFile(join(rootDir, ".vitehub/dev-server.json"), `${JSON.stringify({ root: rootDir, url: devServer })}\n`)
    }
    return rootDir
  }

  it("lists through the Console of the dev server of this project, like every vitehub command", async () => {
    const rootDir = await project("http://localhost:4741/")
    try {
      const app = localApp({ console: () => ({ invocations: [] }) })
      const result = await run(["list"], app.fetch, rootDir)

      expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" })
      expect(app.calls).toEqual([{ method: "POST", operation: "invocations.list", url: "http://localhost:4741/_vitehub/rpc" }])
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("names the fix and reads nothing when no dev server runs for this project", async () => {
    const rootDir = await project()
    try {
      const app = localApp({ console: () => ({ invocations: [] }) })
      const result = await run(["list"], app.fetch, rootDir)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("AGENT_INVOCATIONS_NO_DEV_SERVER")
      expect(result.stderr).toContain("--database .vitehub/data/agent-invocations.sqlite")
      expect(app.calls).toEqual([])
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})

describe("vitehub agent invocations through the Console of the app", () => {
  it("lists capabilities and reads one Invocation Workspace", async () => {
    const app = localApp({ console: operation => operation === "invocations.capabilities" ? { capabilities: [{ name: "fetch" }] } : { files: [] } })
    const capabilities = await run(["capabilities", "--agent", "support", "--url", "http://localhost:3000"], app.fetch)
    expect(capabilities).toEqual({ exitCode: 0, stderr: "", stdout: `${JSON.stringify({ capabilities: [{ name: "fetch" }] }, null, 2)}\n` })
    expect((await run(["workspace", "ainv_1", "--path", "README.md", "--ref=main", "--revision", "rev_1", "--cursor", "next", "--history", "false", "--url", "http://localhost:3000"], app.fetch)).exitCode).toBe(0)
    expect(app.calls.map(call => call.operation)).toEqual(["invocations.capabilities", "invocations.workspace"])
    expect(operationRpcRequest(vi.mocked(app.fetch).mock.calls[1]?.[1]?.body).input).toEqual({ cursor: "next", history: false, id: "ainv_1", path: "README.md", ref: "main", revision: "rev_1" })
    expect((await run(["workspace", "--url", "http://localhost:3000"], app.fetch)).stderr).toContain("workspace requires an invocation id")
  })

  it("deletes through the Console only after a question or --yes", async () => {
    const app = localApp({ console: () => ({ deleted: true }) })
    const refused = await run(["delete", "ainv_1", "--url", "http://localhost:3000"], app.fetch)
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("run it again with --yes")
    expect(app.calls).toEqual([])
    expect(await run(["delete", "ainv_1", "--url", "http://localhost:3000", "--yes"], app.fetch)).toEqual({ exitCode: 0, stderr: "", stdout: "Deleted ainv_1.\n" })
    expect(app.calls.map(call => call.operation)).toEqual(["invocations.delete"])
    expect((await run(["list", "--yes", "--url", "http://localhost:3000"], app.fetch)).stderr).toContain("--yes is only supported for delete")
  })

})
