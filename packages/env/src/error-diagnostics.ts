import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const envErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    ENV_R0001: dynamicError,
    ENV_R0002: dynamicError,
    ENV_R0003: dynamicError,
    ENV_R0004: dynamicError,
    ENV_R0005: dynamicError,
    ENV_R0006: dynamicError,
    ENV_R0007: dynamicError,
    ENV_R0008: dynamicError,
    ENV_R0009: dynamicError,
    ENV_R0010: dynamicError,
    ENV_R0011: dynamicError,
    ENV_R0012: dynamicError,
    ENV_R0013: dynamicError,
    ENV_R0014: dynamicError,
    ENV_R0015: dynamicError,
    ENV_R0016: dynamicError,
    ENV_R0017: dynamicError,
    ENV_R0018: dynamicError,
    ENV_R0019: dynamicError,
    ENV_R0020: dynamicError,
    ENV_R0021: dynamicError,
    ENV_B0001: dynamicError,
    ENV_B0002: dynamicError,
    ENV_B0003: dynamicError,
    ENV_B0004: dynamicError,
    ENV_B0005: dynamicError,
  },
})
