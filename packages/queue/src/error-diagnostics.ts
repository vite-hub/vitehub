import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const queueErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    QUEUE_C0001: dynamicError,
    QUEUE_C0002: dynamicError,
    QUEUE_C0003: dynamicError,
    QUEUE_C0004: dynamicError,
    QUEUE_R0001: dynamicError,
    QUEUE_R0002: dynamicError,
    QUEUE_R0003: dynamicError,
    QUEUE_R0004: dynamicError,
    QUEUE_R0005: dynamicError,
    QUEUE_R0006: dynamicError,
    QUEUE_R0007: dynamicError,
    QUEUE_R0008: dynamicError,
    QUEUE_R0009: dynamicError,
    QUEUE_R0010: dynamicError,
    QUEUE_R0011: dynamicError,
    QUEUE_R0012: dynamicError,
    QUEUE_R0013: dynamicError,
    QUEUE_B0001: dynamicError,
    QUEUE_B0002: dynamicError,
    QUEUE_B0003: dynamicError,
  },
})
