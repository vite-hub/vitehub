import { expect, it } from "vitest"
import { validateAgentStaticRoute } from "../src/internal/routes.ts"

it("rejects a readiness route that would shadow the root handler", () => {
  expect(() => validateAgentStaticRoute("/", [{ route: "/" }])).toThrow("readiness route conflicts")
  expect(validateAgentStaticRoute("/", [{ route: "/health" }])).toBe("/")
})

it("compares normalized readiness paths with host handlers", () => {
  expect(validateAgentStaticRoute("health/", [{ route: "/other" }])).toBe("/health")
  for (const handler of ["health", "/health/", "/:page", "/**"]) {
    expect(() => validateAgentStaticRoute("health/", [{ route: handler }])).toThrow("readiness route conflicts")
  }
})
