import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const realtimeErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    REALTIME_R0013: dynamicError,
    REALTIME_R0001: dynamicError,
    REALTIME_R0002: dynamicError,
    REALTIME_R0003: dynamicError,
    REALTIME_R0004: dynamicError,
    REALTIME_R0005: dynamicError,
    REALTIME_R0006: dynamicError,
    REALTIME_R0007: dynamicError,
    REALTIME_R0008: dynamicError,
    REALTIME_B0001: dynamicError,
    REALTIME_B0002: dynamicError,
    REALTIME_B0003: dynamicError,
    REALTIME_R0009: dynamicError,
    REALTIME_R0010: dynamicError,
    REALTIME_R0011: dynamicError,
    REALTIME_R0012: dynamicError,
  },
})
