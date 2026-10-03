import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ensureWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } from "@vite-hub/workspace/server"

const modelGenerate = vi.hoisted(() => vi.fn())
const registry = vi.hoisted((): Record<string, () => Promise<unknown>> => ({}))

vi.mock("#vitehub/agent/registry", () => ({ default: registry }))
vi.mock("../src/internal/ai-sdk-runtime.ts", () => ({
  loadAiSdk: async () => ({
    ToolLoopAgent: class {
      async generate(...args: unknown[]) {
        return await modelGenerate(...args)
      }
    },
    isStepCount: () => () => false,
    jsonSchema: (schema: unknown) => schema,
  }),
}))

import { defineAgent, runAgent } from "../src/index.ts"
import { agentInvocationsDevHeader, agentInvocationsDevRuntimeRoute, agentInvocationsDevTokenServerHeader } from "../src/invocations-dev.ts"
import { handleAgentInvocationsDevRequest } from "../src/runtime/invocations-dev.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { hubAgent } from "../src/vite.ts"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import type { AgentInvocations } from "../src/index.ts"

const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: vi.fn() })
// SAFETY: The mocked AI SDK never reads the model; the hoisted generate mock handles execution.
const modelDriver = { execution: { workspaceFallback: false }, model: {} as never }

function devRequest(body: unknown, headers: Record<string, string> = { [agentInvocationsDevHeader]: "1" }): Request {
  return new Request(`http://localhost${agentInvocationsDevRuntimeRoute}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

async function runningId(invocations: AgentInvocations, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await invocations.getByRunId(runId, "digest")
    if (record?.status === "running") return record.id
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Invocation ${runId} did not start.`)
}

afterEach(() => {
  modelGenerate.mockReset()
  for (const name of Object.keys(registry)) Reflect.deleteProperty(registry, name)
})

describe("Agent Invocations Nitro dev handler", () => {
  it("generates a handler that authenticates with the project root and server ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-handler-"))
    try {
      const plugin = hubAgent({ providers: { state: { provider: "memory" } } })
      const hook = plugin.configResolved
      if (!hasRuntimeType(hook, "function")) throw new Error("Expected a configResolved hook")
      // SAFETY: Agent output generation reads only these resolved config fields in this fixture.
      await hook.call({} as never, { root, command: "serve", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] }, server: { port: 5173 } } as never)
      const source = await readFile(join(root, ".vitehub/agent/invocations-dev-handler.ts"), "utf8")
      // Execute the generated callback with its real owner handler to verify the authorization boundary.
      const callback: (event: { req: Request }) => Promise<Response> = new Function("defineEventHandler", "handleViteHubDevRequest", source.replace(/^import .*\n/gm, "").replace("export default", "return"))((handler: unknown) => handler, handleAgentInvocationsDevRequest)
      const body = { id: "ainv_missing", operation: "cancel" }
      expect((await callback({ req: devRequest(body) })).status).toBe(403)
      const serverId = workspaceDevTokenServerId(5173)
      const token = await ensureWorkspaceDevToken(root, { serverId })
      const response = await callback({ req: devRequest(body, {
        [agentInvocationsDevHeader]: "1",
        [agentInvocationsDevTokenServerHeader]: serverId,
        [workspaceDevTokenHeader]: token,
      }) })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { message: "No Agent invocation journal is configured." } })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("cancels a running Invocation through the application registry", async () => {
    modelGenerate.mockImplementation(async (input: { abortSignal?: AbortSignal }) => await new Promise((_resolve, reject) => {
      const signal = input.abortSignal
      if (signal?.aborted) reject(signal.reason)
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const agent = defineAgent({ driver: modelDriver, invocations, name: "digest" })
    registry.digest = async () => ({ default: agent })
    registry.broken = async () => { throw new Error("Definition failed to load.") }
    const run = runAgent(agent, runtime("dev-cancel"), { prompt: "Summarize the release." })
    const id = await runningId(invocations, "dev-cancel")

    const response = await handleAgentInvocationsDevRequest(devRequest({ id, operation: "cancel" }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delivery: "local", id, outcome: "requested", status: "running" })
    await expect(run).rejects.toThrow(`Cancellation was requested for Agent Invocation "${id}"`)
    expect((await invocations.get(id))?.status).toBe("cancelled")

    const missing = await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_missing", operation: "cancel" }))
    expect(await missing.json()).toEqual({ id: "ainv_missing", outcome: "not-found" })
  })

  it("rejects requests without the guard, with an invalid body, or without a journal", async () => {
    expect((await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_1", operation: "cancel" }, {}))).status).toBe(403)
    expect((await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_1", operation: "cancel" }, {
      [agentInvocationsDevHeader]: "1",
      origin: "https://attacker.example",
    }))).status).toBe(403)
    expect((await handleAgentInvocationsDevRequest(devRequest({ operation: "cancel" }))).status).toBe(400)

    registry.plain = async () => ({ default: defineAgent({ driver: modelDriver, name: "plain" }) })
    const response = await handleAgentInvocationsDevRequest(devRequest({ id: "ainv_1", operation: "cancel" }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { message: "No Agent invocation journal is configured." } })
  })
})
