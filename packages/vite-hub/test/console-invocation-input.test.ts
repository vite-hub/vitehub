import { describe, expect, it, vi } from "vitest"
import { startConsoleAgentInvocation } from "../src/console/runtime/client/invocation.ts"
import { requestConsole } from "../src/console/runtime/client/request.ts"

vi.mock("../src/console/runtime/client/request.ts", () => ({ requestConsole: vi.fn() }))

describe("Console invocation input", () => {
  it("keeps the Agent, route, and profile selected when image uploads begin", async () => {
    const uploaded = Promise.withResolvers<unknown>()
    vi.mocked(requestConsole).mockReset().mockReturnValueOnce(uploaded.promise).mockResolvedValueOnce({ id: "invocation" })
    const target = { agent: "first", base: "/first/api/_vitehub/console/agents", invokerProfileId: "reader" }
    const started = startConsoleAgentInvocation(target, { text: "Explain this image", files: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aQ==" }] })
    target.agent = "second"
    target.base = "/second/api/_vitehub/console/agents"
    target.invokerProfileId = "administrator"
    uploaded.resolve({ id: "image" })
    expect(await started).toEqual({ agent: "first", id: "invocation" })
    expect(requestConsole).toHaveBeenNthCalledWith(2, "/first/api/_vitehub/console/agents/first/invocations", {
      body: { attachments: [{ id: "image", name: "image" }], invokerProfileId: "reader", prompt: "Explain this image" }, method: "POST",
    })
  })

  it("does not start an invocation when an upload fails", async () => {
    vi.mocked(requestConsole).mockReset().mockRejectedValueOnce(new Error("Storage unavailable"))
    await expect(startConsoleAgentInvocation({ agent: "first", base: "/api/_vitehub/console/agents" }, { text: "", files: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aQ==" }] })).rejects.toThrow("Storage unavailable")
    expect(requestConsole).toHaveBeenCalledOnce()
  })
})
