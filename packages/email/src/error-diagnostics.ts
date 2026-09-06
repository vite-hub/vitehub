import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const emailErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    EMAIL_R0001: dynamicError,
    EMAIL_R0002: dynamicError,
    EMAIL_R0003: dynamicError,
    EMAIL_R0004: dynamicError,
    EMAIL_R0005: dynamicError,
    EMAIL_R0006: dynamicError,
    EMAIL_R0007: dynamicError,
    EMAIL_B0001: dynamicError,
    EMAIL_B0002: dynamicError,
    EMAIL_B0003: dynamicError,
    EMAIL_B0004: dynamicError,
    EMAIL_B0005: dynamicError,
    EMAIL_B0006: dynamicError,
    EMAIL_B0007: dynamicError,
  },
})
