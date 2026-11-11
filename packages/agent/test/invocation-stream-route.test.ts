import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

import { registerViteHubDevEndpoint } from "@vite-hub/internal/dev-endpoint"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { registerAgentInvocationStreamEndpoint } from "../src/vite/invocation-stream-route.ts"

import type { handleAgentInvocationStreamEndpoint } from "../src/vite/invocation-stream-endpoint.ts"

vi.mock("@vite-hub/internal/dev-endpoint", () => ({ registerViteHubDevEndpoint: vi.fn() }))
vi.mock("@vite-hub/workspace/server", () => ({
  refreshWorkspaceDevToken: vi.fn(async () => {}),
  validateWorkspaceDevToken: vi.fn(async () => true),
  workspaceDevTokenServerId: vi.fn(() => "test-server"),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function setup() {
  const handleEndpoint = vi.fn<typeof handleAgentInvocationStreamEndpoint>()
  const loading = deferred<{ handleAgentInvocationStreamEndpoint: typeof handleEndpoint }>()
  const loadEndpoint = vi.fn(() => loading.promise)
  vi.doMock("../src/vite/invocation-stream-endpoint.ts", loadEndpoint)
  const server = { config: { root: "/app", server: { port: 5173 } } }
  const runtimeOptions = { runtimeCapabilities: [] }
  await registerAgentInvocationStreamEndpoint(server as never, runtimeOptions)
  const options = vi.mocked(registerViteHubDevEndpoint).mock.calls.at(-1)![1]
  const req = new IncomingMessage(new Socket())
  const res = new ServerResponse(req)
  const end = vi.spyOn(res, "end")
  const grant = {} as never
  async function start() {
    options.handle(req, res, grant)
    await vi.waitFor(() => expect(loadEndpoint).toHaveBeenCalledOnce())
  }
  return { end, grant, handleEndpoint, loadEndpoint, loading, req, res, runtimeOptions, server, start }
}

describe("Agent Dev Loop lazy route", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.doUnmock("../src/vite/invocation-stream-endpoint.ts")
    vi.restoreAllMocks()
  })

  it("loads the runtime only for a request and hands it the request context", async () => {
    const { grant, handleEndpoint, loadEndpoint, loading, req, res, runtimeOptions, server, start } = await setup()
    expect(loadEndpoint).not.toHaveBeenCalled()

    await start()
    loading.resolve({ handleAgentInvocationStreamEndpoint: handleEndpoint })
    await vi.dynamicImportSettled()

    expect(handleEndpoint).toHaveBeenCalledExactlyOnceWith(server, req, res, grant, { serverId: "test-server" }, runtimeOptions)
    expect(res.listenerCount("close")).toBe(0)
  })

  it("ends a controlled error response when loading rejects", async () => {
    const { end, handleEndpoint, loading, res, start } = await setup()
    await start()
    loading.reject(new Error("Module evaluation failed"))
    await vi.dynamicImportSettled()

    expect(res.statusCode).toBe(500)
    expect(res.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledWith("Agent Invocation Stream endpoint failed.")
    expect(handleEndpoint).not.toHaveBeenCalled()
    expect(res.listenerCount("close")).toBe(0)
  })

  it("skips Agent work when the response closes during loading", async () => {
    const { handleEndpoint, loading, res, start } = await setup()
    await start()
    res.emit("close")
    loading.resolve({ handleAgentInvocationStreamEndpoint: handleEndpoint })
    await vi.dynamicImportSettled()

    expect(handleEndpoint).not.toHaveBeenCalled()
    expect(res.listenerCount("close")).toBe(0)
  })

  it("handles a load failure after the client has disconnected", async () => {
    const { end, loading, res, start } = await setup()
    await start()
    res.emit("close")
    loading.reject(new Error("Module evaluation failed"))
    await vi.dynamicImportSettled()

    expect(end).not.toHaveBeenCalled()
    expect(res.listenerCount("close")).toBe(0)
  })

  it("skips Agent work for an already destroyed response", async () => {
    const { handleEndpoint, loading, res, start } = await setup()
    res.destroy()
    await start()
    loading.resolve({ handleAgentInvocationStreamEndpoint: handleEndpoint })
    await vi.dynamicImportSettled()

    expect(handleEndpoint).not.toHaveBeenCalled()
    expect(res.listenerCount("close")).toBe(0)
  })
})
