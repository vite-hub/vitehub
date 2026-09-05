import { expect, it } from "vitest"
import { validateAgentPreparationRoute } from "../src/internal/routes.ts"

it("rejects a readiness route that would shadow the root handler", () => {
  expect(() => validateAgentPreparationRoute("/", [{ route: "/" }])).toThrow("readiness route conflicts")
  expect(validateAgentPreparationRoute("/", [{ route: "/health" }])).toBe("/")
})

it("compares normalized readiness paths with host handlers", () => {
  expect(validateAgentPreparationRoute("health/", [{ route: "/other" }])).toBe("/health")
  for (const handler of ["health", "/health/", "/:page", "/**"]) {
    expect(() => validateAgentPreparationRoute("health/", [{ route: handler }])).toThrow("readiness route conflicts")
  }
})
