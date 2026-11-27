import { defineErrors } from "@vite-hub/runtime"

import type { ErrorCatalog } from "@vite-hub/runtime"

type BrowserRunErrorCodes = {
  BROWSER_CONTENT_FAILED: { fix: string, status: number, why: (data: { status?: number }) => string }
  BROWSER_DEFINITION_NOT_FOUND: { fix: string, status: number, why: (data: { name: string }) => string }
  BROWSER_RUN_FAILED: { fix: string, why: (data: { name: string }) => string }
}

export const browserRunErrors: ErrorCatalog<BrowserRunErrorCodes> = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/browser/diagnostics",
  codes: {
    // Runtime errors.
    BROWSER_CONTENT_FAILED: {
      why: ({ status }: { status?: number }) => status === undefined ? "The Browser content request failed." : `Browser content request failed with status ${status}`,
      fix: "Call `runBrowserAction(\"content\", input)` to read the `error.code` and `error.message` of the failed request, then fix the Browser binding or the input that they name. `error.cause` has the provider error when the read failed.",
      status: 502,
    },
    BROWSER_DEFINITION_NOT_FOUND: {
      why: ({ name }: { name: string }) => `No Browser Definition is named ${JSON.stringify(name)}.`,
      fix: "Add `server/browsers/<name>.ts` that default-exports `defineBrowser()`, or pass a name that `vitehub inspect definitions --kind browser` lists.",
      status: 404,
    },
    BROWSER_RUN_FAILED: {
      why: ({ name }: { name: string }) => `Browser Definition ${JSON.stringify(name)} failed.`,
      fix: "Read `error.cause` for the error of the handler or of Browser Run. A timeout or a provider error has the code `BROWSER_PROVIDER_ERROR`.",
    },
  },
})

/** Why `runBrowser()` returned an error. */
export type BrowserRunErrorCode = "BROWSER_DEFINITION_NOT_FOUND" | "BROWSER_RUN_FAILED"
