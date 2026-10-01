import { describe, expect, it } from "vitest"

import { isAmbiguousAgentWorkflowStartFailure } from "../src/internal/workflow-start.ts"

describe("workflow start failure classification", () => {
  it("rejects callable failures", () => {
    const failure = Object.assign(() => undefined, {
      code: "WORKFLOW_PROVIDER_OPERATION_FAILED",
      details: { acknowledgement: "unknown", provider: "cloudflare", operation: "create" },
    })

    expect(isAmbiguousAgentWorkflowStartFailure(failure)).toBe(false)
  })

  it("does not throw for revoked proxies", () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()

    expect(isAmbiguousAgentWorkflowStartFailure(proxy)).toBe(false)
  })
})
