import { expect, it } from "vitest"

import { shellErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives SHELL_SH_SYNTAX_WASM_UNAVAILABLE a fix and its own docs page", () => {
  const error = shellErrorDiagnostics.SHELL_SH_SYNTAX_WASM_UNAVAILABLE()
  expect(error.fix).toContain("vitehub()")
  expect(error.docs).toBe("https://vitehub.dev/docs/shell/diagnostics/shell_sh_syntax_wasm_unavailable")
})
