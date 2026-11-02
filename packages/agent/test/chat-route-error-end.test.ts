import { describe, expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { defineChatCapability } from "../src/chat-trigger.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"

describe("Agent chat route errors", () => {
  it("ends the response after it sends the error frame", async () => {
    const handler = createChannelChatRouteHandler(
      // SAFETY: The minimal Agent definition exercises only the route's UI message stream.
      defineAgent({ capabilities: [defineChatCapability()], driver: { run: () => (async function* () {
        yield { error: agentDiagnostics.AGENT_R1016({ connection: "chatgpt", problem: "sign-in" }), type: "error" }
      })() } }) as never,
    )
    const body = JSON.stringify({ id: "chat-1", messages: [{ id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" }] })
    // SAFETY: agentName is the only route option this test needs.
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", { body, headers: { "content-type": "application/json" }, method: "POST" }), { agentName: "support" } as never)

    // H3 1 never ends a Node response whose body stream errors, so a body that errors after the frame hangs the request.
    const text = await response.text()
    expect(text).toContain('"errorText":"AGENT_R1016: The ChatGPT Connection cannot provide plan access (sign-in).","type":"error"')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  })
})
