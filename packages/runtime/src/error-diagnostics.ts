import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const runtimeErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    RUNTIME_R0001: dynamicError,
    RUNTIME_R0002: dynamicError,
    RUNTIME_R0003: dynamicError,
    RUNTIME_R0004: dynamicError,
    RUNTIME_R0005: dynamicError,
    RUNTIME_R0006: dynamicError,
    RUNTIME_R0007: dynamicError,
    RUNTIME_R0008: dynamicError,
    RUNTIME_R0009: dynamicError,
    RUNTIME_R0010: dynamicError,
    RUNTIME_R0011: dynamicError,
  },
})
