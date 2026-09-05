import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const databaseErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    DATABASE_C0001: dynamicError,
    DATABASE_C0002: dynamicError,
    DATABASE_C0003: dynamicError,
    DATABASE_C0004: dynamicError,
    DATABASE_C0005: dynamicError,
    DATABASE_C0006: dynamicError,
    DATABASE_C0007: dynamicError,
    DATABASE_R0001: dynamicError,
    DATABASE_R0002: dynamicError,
    DATABASE_R0003: dynamicError,
    DATABASE_B0001: dynamicError,
    DATABASE_B0002: dynamicError,
    DATABASE_R0004: dynamicError,
    DATABASE_R0005: dynamicError,
    DATABASE_R0006: dynamicError,
    DATABASE_R0007: dynamicError,
    DATABASE_R0008: dynamicError,
    DATABASE_R0009: dynamicError,
    DATABASE_R0010: dynamicError,
    DATABASE_R0011: dynamicError,
    DATABASE_R0012: dynamicError,
    DATABASE_R0013: dynamicError,
    DATABASE_R0014: dynamicError,
    DATABASE_R0015: dynamicError,
    DATABASE_R0016: dynamicError,
  },
})
