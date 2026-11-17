import { expect, it } from "vitest"

import { viteHubErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives VITE_HUB_SETUP_BODY_TOO_LARGE a fix and its own docs page", () => {
  const error = viteHubErrorDiagnostics.VITE_HUB_SETUP_BODY_TOO_LARGE({ limit: 65_536 })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe("https://vitehub.dev/docs/development/diagnostics/vite_hub_setup_body_too_large")
})
