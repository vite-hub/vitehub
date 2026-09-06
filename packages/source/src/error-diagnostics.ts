import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const sourceErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    SOURCE_R0023: dynamicError,
    SOURCE_R0001: dynamicError,
    SOURCE_R0002: dynamicError,
    SOURCE_R0003: dynamicError,
    SOURCE_R0004: dynamicError,
    SOURCE_R0005: dynamicError,
    SOURCE_R0006: dynamicError,
    SOURCE_R0007: dynamicError,
    SOURCE_R0008: dynamicError,
    SOURCE_R0009: dynamicError,
    SOURCE_R0010: dynamicError,
    SOURCE_R0011: dynamicError,
    SOURCE_R0012: dynamicError,
    SOURCE_R0013: dynamicError,
    SOURCE_R0014: dynamicError,
    SOURCE_R0015: dynamicError,
    SOURCE_R0016: dynamicError,
    SOURCE_R0017: dynamicError,
    SOURCE_R0018: dynamicError,
    SOURCE_R0019: dynamicError,
    SOURCE_R0020: dynamicError,
    SOURCE_R0021: dynamicError,
    SOURCE_R0022: dynamicError,
    SOURCE_B0001: dynamicError,
    SOURCE_B0002: dynamicError,
    SOURCE_B0003: dynamicError,
    SOURCE_B0004: dynamicError,
    SOURCE_B0005: dynamicError,
    SOURCE_B0006: dynamicError,
    SOURCE_B0007: dynamicError,
    SOURCE_B0008: dynamicError,
  },
})
