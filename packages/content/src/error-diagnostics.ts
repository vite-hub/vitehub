import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const contentErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    CONTENT_R0001: dynamicError,
    CONTENT_R0002: dynamicError,
    CONTENT_R0003: dynamicError,
    CONTENT_R0004: dynamicError,
    CONTENT_R0005: dynamicError,
  },
})
