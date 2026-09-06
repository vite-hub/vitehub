import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const kvErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    KV_R0013: dynamicError,
    KV_R0014: dynamicError,
    KV_C0001: dynamicError,
    KV_C0002: dynamicError,
    KV_C0003: dynamicError,
    KV_R0001: dynamicError,
    KV_R0002: dynamicError,
    KV_R0003: dynamicError,
    KV_R0004: dynamicError,
    KV_R0005: dynamicError,
    KV_R0006: dynamicError,
    KV_R0007: dynamicError,
    KV_R0008: dynamicError,
    KV_R0009: dynamicError,
    KV_R0010: dynamicError,
    KV_R0011: dynamicError,
    KV_R0012: dynamicError,
    KV_R0015: dynamicError,
    KV_R0016: dynamicError,
    KV_R0017: dynamicError,
    KV_R0018: dynamicError,
  },
})
