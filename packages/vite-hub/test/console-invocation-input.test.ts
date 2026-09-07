import { describe, expect, it, vi } from "vitest"
import { effectScope, reactive } from "vue"
import { startConsoleAgentInvocation, useConsoleInvocationTarget } from "../src/console/runtime/client/invocation.ts"
import { requestConsole } from "../src/console/runtime/client/request.ts"

vi.mock("../src/console/runtime/client/request.ts", () => ({ requestConsole: vi.fn() }))

describe("Console invocation input", () => {
  it("keeps the Agent, route, and profile selected when image uploads begin", async () => {
    let complete: (value: unknown) => void = () => {}
    const uploaded = new Promise<unknown>(resolve => { complete = resolve })
    vi.mocked(requestConsole).mockReset().mockReturnValueOnce(uploaded)
    const target = { agent: "first", base: "/first/api/_vitehub/console/agents", invokerProfileId: "reader" }
    const started = startConsoleAgentInvocation(target, { text: "Explain this image", files: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aQ==" }] })
    target.agent = "second"
    target.base = "/second/api/_vitehub/console/agents"
    target.invokerProfileId = "administrator"
    complete({ id: "invocation" })
    expect(await started).toEqual({ agent: "first", id: "invocation" })
    expect(requestConsole).toHaveBeenCalledExactlyOnceWith("/first/api/_vitehub/console/agents/first/invocations", {
      body: { files: [{ url: "data:image/png;base64,aQ==", filename: "image" }], invokerProfileId: "reader", prompt: "Explain this image" }, method: "POST",
    })
  })

  it.each(["agent", "base", "invokerProfileId"] as const)("invalidates a pending result when %s changes away and back", (field) => {
    const scope = effectScope()
    try {
      scope.run(() => {
        const target = reactive({ agent: "first", base: "/agents", invokerProfileId: "reader" })
        const capture = useConsoleInvocationTarget(() => target)
        const pending = capture()
        expect(pending.isCurrent()).toBe(true)
        const initial = target[field]
        target[field] = "other"
        target[field] = initial
        expect(pending.isCurrent()).toBe(false)
        expect(capture().isCurrent()).toBe(true)
      })
    } finally {
      scope.stop()
    }
  })

  it("does not start an invocation when an upload fails", async () => {
    vi.mocked(requestConsole).mockReset().mockRejectedValueOnce(new Error("Storage unavailable"))
    await expect(startConsoleAgentInvocation({ agent: "first", base: "/api/_vitehub/console/agents" }, { text: "", files: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aQ==" }] })).rejects.toThrow("Storage unavailable")
    expect(requestConsole).toHaveBeenCalledOnce()
  })
})
