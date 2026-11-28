import { describe, expect, it } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { createMessage } from "../src/messages.ts"

function echoPrompt() {
  return defineAgent({
    runtime: false,
    driver: { run: ({ prompt }) => ({ text: prompt ?? "no prompt" }) },
  })
}

describe("run context prompt", () => {
  it("keeps the prompt that the caller passes", async () => {
    const [error, result] = await runAgent(echoPrompt(), { prompt: "Ada" })
    expect(error).toBeUndefined()
    expect(result?.text).toBe("Ada")
  })

  it("reads the latest user message when the input has only messages", async () => {
    const [error, result] = await runAgent(echoPrompt(), {
      messages: [
        createMessage({ role: "user", text: "first" }),
        createMessage({ role: "assistant", text: "reply" }),
        createMessage({ role: "user", text: "Ada" }),
      ],
    })
    expect(error).toBeUndefined()
    expect(result?.text).toBe("Ada")
  })

  it("has no prompt when no user message has text", async () => {
    const [error, result] = await runAgent(echoPrompt(), {
      messages: [createMessage({ role: "assistant", text: "reply" })],
    })
    expect(error).toBeUndefined()
    expect(result?.text).toBe("no prompt")
  })
})
