import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const shellErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    SHELL_R0001: dynamicError,
    SHELL_R0002: dynamicError,
    SHELL_R0003: dynamicError,
    SHELL_R0004: dynamicError,
    SHELL_R0005: dynamicError,
    SHELL_R0006: dynamicError,
    SHELL_R0007: dynamicError,
    SHELL_R0008: dynamicError,
    SHELL_R0009: dynamicError,
    SHELL_R0010: dynamicError,
    SHELL_R0011: dynamicError,
    SHELL_R0012: dynamicError,
    SHELL_R0013: dynamicError,
    SHELL_R0014: dynamicError,
    SHELL_R0015: dynamicError,
    SHELL_R0016: dynamicError,
    SHELL_R0017: dynamicError,
    SHELL_R0018: dynamicError,
    SHELL_R0019: dynamicError,
    SHELL_R0020: dynamicError,
    SHELL_R0021: dynamicError,
  },
})
