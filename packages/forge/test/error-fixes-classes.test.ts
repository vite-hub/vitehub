import { expect, it } from "vitest"

import { forgeResponseError, isForgeResponseError } from "../src/index.ts"

it("gives FORGE_RESPONSE_INVALID a fix and its own docs page", () => {
  const error = forgeResponseError("GitHub returned a malformed blob abc.")
  expect(isForgeResponseError(error)).toBe(true)
  expect(error).toMatchObject({ code: "FORGE_RESPONSE_INVALID", docs: "https://vitehub.dev/docs/forge/diagnostics/forge_response_invalid", fix: expect.stringContaining("GitHub App"), message: "GitHub returned a malformed blob abc." })
})
