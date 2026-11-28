import { describe, expect, it } from "vitest"

import { toAgentPublicError } from "../src/agent-error.ts"
import { defineAgent, runAgent, streamAgent } from "../src/index.ts"

function gatewayAuthenticationError(): Error {
  const error = new Error("\u001B[1mAI Gateway authentication failed: No authentication provided.\u001B[0m")
  error.name = "GatewayAuthenticationError"
  Object.assign(error, {
    [Symbol.for("vercel.ai.gateway.error")]: true,
    [Symbol.for("vercel.ai.gateway.error.GatewayAuthenticationError")]: true,
    statusCode: 401,
    type: "authentication_error",
  })
  return error
}

describe("AI Gateway authentication failures", () => {
  it("returns AGENT_MODEL_GATEWAY_UNAUTHENTICATED from runAgent() and streamAgent()", async () => {
    const failure = gatewayAuthenticationError()
    const agent = defineAgent({ driver: { run() { throw failure } }, runtime: false })

    const [error] = await runAgent(agent, { prompt: "hello" })
    expect(error).toMatchObject({
      code: "AGENT_MODEL_GATEWAY_UNAUTHENTICATED",
      docs: "https://vitehub.dev/docs/agents/diagnostics/agent_model_gateway_unauthenticated",
      fix: expect.stringContaining("AI_GATEWAY_API_KEY"),
    })
    expect(error?.fix).toContain("agent.models.emulate")
    expect(error?.cause).toBe(failure)

    const [streamError] = await streamAgent(agent, { prompt: "hello" })
    expect(streamError?.code).toBe("AGENT_MODEL_GATEWAY_UNAUTHENTICATED")
  })

  it("finds the error inside an AI SDK retry and a wrapping cause", async () => {
    const failure = gatewayAuthenticationError()
    const retry = Object.assign(new Error("retries failed"), { name: "AI_RetryError", lastError: failure })
    const agent = defineAgent({ driver: { run() { throw new Error("Driver failed.", { cause: retry }) } }, runtime: false })

    const [error] = await runAgent(agent, {})
    expect(error?.code).toBe("AGENT_MODEL_GATEWAY_UNAUTHENTICATED")
  })

  it("keeps AGENT_RUN_FAILED for an error that only has the name or the message", async () => {
    const lookalike = Object.assign(new Error("AI Gateway authentication failed"), { name: "GatewayAuthenticationError" })
    const [error] = await runAgent(defineAgent({ driver: { run() { throw lookalike } }, runtime: false }), {})
    expect(error?.code).toBe("AGENT_RUN_FAILED")
  })

  it("tells chat users that the AI provider rejected the credentials", () => {
    expect(toAgentPublicError(gatewayAuthenticationError(), "http")).toEqual({
      code: "PROVIDER_AUTHENTICATION_FAILED",
      error: "AI provider credentials were rejected.",
    })
  })
})
