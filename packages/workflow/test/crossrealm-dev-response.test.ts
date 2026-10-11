import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { toWorkflowDevRunView } from "../src/runtime/dev.ts"

describe("workflow dev cross realm response probe", () => {
  it("reads a response created by another realm", async () => {
    const foreignResponse = runInNewContext(`class ForeignResponse {
      constructor(body) { this.body = body; this.status = 201; this.statusText = "Created" }
      clone() { return { text: async () => this.body } }
      get [Symbol.toStringTag]() { return "Response" }
    }
    new ForeignResponse('{"ok":true}')`)
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const run = {
      id: "cross-realm",
      provider: "vercel",
      status: "completed",
      result: foreignResponse,
    } as any
    const view = await toWorkflowDevRunView(run, "probe")
    expect(view.result).toEqual({ ok: true })
  })

  it("does not treat a spoofed response tag as a response", async () => {
    const spoofedResponse = runInNewContext(`({
      body: '{"ok":true}',
      status: 201,
      statusText: "Created",
      clone() { throw new Error("should not read the body") },
      get [Symbol.toStringTag]() { return "Response" }
    })`)
    const run = {
      id: "spoofed-response",
      provider: "vercel",
      status: "completed",
      result: spoofedResponse,
    } as any
    const view = await toWorkflowDevRunView(run, "probe")
    expect(view.result).toEqual({ body: '{"ok":true}', status: 201, statusText: "Created" })
  })
})
