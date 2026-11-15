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
    BROWSER_B0001: { ...dynamicError, fix: "Set `browser: { binding }` in `vitehub()` to letters, digits, and `_` that do not start with a digit, such as `\"BROWSER\"`, or remove `binding`." },
    BROWSER_B0002: { ...dynamicError, fix: "Set `browser: { engine }` in `vitehub()` to `\"kitesurf\"` or `\"chromium\"`, or remove `engine` to use Kitesurf." },
  },
})
