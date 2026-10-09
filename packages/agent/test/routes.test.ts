import { describe, expect, it } from "vitest"

import { resolveAgentRoutePath, validateAgentStaticRoute } from "../src/internal/routes.ts"

describe("agent route paths", () => {
  it("does not resolve route placeholders through Object.prototype", () => {
    expect(resolveAgentRoutePath("/hooks/[toString]/[agent]", { agent: "support" })).toBe("/hooks/:toString/support")
  })
})

// Only literal enclosing fallbacks may share the framework-reserved namespace.
it.each(["/_vitehub/**:rest", "/_vitehub/**rest", "/_vitehub/:...rest", "/_vitehub/:section/**", "/:section/**", "/_vitehub/*/**"])("rejects a parameter or wildcard catch-all %s", (route) => {
  expect(() => validateAgentStaticRoute("/_vitehub/agent/invocations/dev", [{ route }], "development invocation", "/_vitehub/agent")).toThrow(/route conflicts/)
})

it.each(["/_vitehub/**", "/**"])("allows enclosing %s only for the reserved dev route", (route) => {
  expect(validateAgentStaticRoute("/_vitehub/agent/invocations/dev", [{ route }], "development invocation", "/_vitehub/agent")).toBe("/_vitehub/agent/invocations/dev")
  expect(() => validateAgentStaticRoute("/_vitehub/agent/invocations/dev", [{ route }])).toThrow(/route conflicts/)
})
