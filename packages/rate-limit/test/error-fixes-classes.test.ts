import { expect, it } from "vitest"

import { rateLimitErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives RATE_LIMIT_OPERATION_FAILED a fix and its own docs page", () => {
  const error = rateLimitErrorDiagnostics.RATE_LIMIT_OPERATION_FAILED()
  expect(error.code).toBe("RATE_LIMIT_OPERATION_FAILED")
  expect(error.fix).toContain("error.cause")
  expect(error.docs).toBe("https://vitehub.dev/docs/rate-limit/diagnostics/rate_limit_operation_failed")
})
