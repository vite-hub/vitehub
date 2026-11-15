import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const browserErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/browser/diagnostics",
  codes: {
    BROWSER_R0001: dynamicError,
    BROWSER_R0002: dynamicError,
    BROWSER_R0003: dynamicError,
    BROWSER_R0004: dynamicError,
    BROWSER_R0005: dynamicError,
    BROWSER_R0006: dynamicError,
    BROWSER_R0007: dynamicError,
    BROWSER_R0008: dynamicError,
    BROWSER_R0009: dynamicError,
    BROWSER_R0010: dynamicError,
    BROWSER_R0011: dynamicError,
    BROWSER_B0001: dynamicError,
    BROWSER_B0002: dynamicError,
    // Named errors. Keep these codes in alphabetical order.
    BROWSER_CONTENT_FAILED: {
      why: ({ status }: { status: number }) => `Browser content request failed with status ${status}`,
      fix: "Call `runBrowserAction(\"content\", input)` to read the `error.code` and `error.message` of the failed request, then fix the Browser binding or the input that they name.",
    },
  },
})
