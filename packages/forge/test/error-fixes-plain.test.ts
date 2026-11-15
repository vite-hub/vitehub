import { expect, it } from "vitest"

import { forgeDiagnostics } from "../src/error-diagnostics.ts"
import { forgeProvider } from "../src/provider.ts"

it("gives FORGE_UNSUPPORTED a fix and its own docs page", () => {
  const error = forgeDiagnostics.FORGE_UNSUPPORTED()
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe("https://vitehub.dev/docs/forge/diagnostics/forge_unsupported")
})

it("reports an unknown Forge with its code and fix", async () => {
  // SAFETY: the test passes a Forge name that the type forbids, as a JavaScript caller can.
  await expect(forgeProvider({ forge: "bitbucket" } as never)).rejects.toMatchObject({
    code: "FORGE_UNSUPPORTED",
    fix: expect.stringContaining("`forgejo`"),
  })
})
