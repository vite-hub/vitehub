import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { toWorkflowRunView } from "../src/runtime/operations.ts"
import type { WorkflowRun } from "../src/types.ts"

describe("workflow run view cross realm response probe", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads a response created by another realm", async () => {
    const NativeResponse = Response
    const foreignResponse: Response = runInNewContext(
      `
      class ForeignResponse extends NativeResponse {}
      new ForeignResponse(JSON.stringify({ ok: true }), { status: 201, statusText: "Created" })
    `,
      { NativeResponse },
    )
    // Inject the platform implementation into the VM and use a distinct local constructor.
    class LocalResponse extends NativeResponse {}
    Object.defineProperties(LocalResponse.prototype, Object.getOwnPropertyDescriptors(NativeResponse.prototype))
    vi.stubGlobal("Response", LocalResponse)
    expect(foreignResponse).toBeInstanceOf(NativeResponse)
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const run = {
      id: "cross-realm",
      provider: "vercel",
      status: "completed",
      result: foreignResponse,
      metadata: { response: foreignResponse },
    } satisfies WorkflowRun
    const view = await toWorkflowRunView(run, "probe")
    expect(view.result).toEqual({ ok: true })
    expect(view.metadata).toEqual({ response: { response: { status: 201, statusText: "Created" } } })
  })

  it("keeps an Axios response, which has status and headers but no Response body", async () => {
    const axiosResponse = {
      config: {},
      data: { userId: "user-123" },
      headers: { get: (name: string) => name === "content-type" ? "application/json" : undefined },
      request: {},
      status: 200,
      statusText: "OK",
    }
    const run = {
      id: "axios",
      provider: "vercel",
      status: "completed",
      result: axiosResponse,
      metadata: { response: axiosResponse },
    } satisfies WorkflowRun
    const view = await toWorkflowRunView(run, "probe")
    expect(view.result).toEqual({ config: {}, data: { userId: "user-123" }, headers: {}, request: {}, status: 200, statusText: "OK" })
    expect(view.metadata).toEqual({ response: { config: {}, data: { userId: "user-123" }, headers: {}, request: {}, status: 200, statusText: "OK" } })
  })
})
