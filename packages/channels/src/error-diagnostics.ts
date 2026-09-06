import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const channelsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    CHANNELS_R0001: dynamicError,
    CHANNELS_C0001: dynamicError,
    CHANNELS_C0002: dynamicError,
    CHANNELS_C0003: dynamicError,
    CHANNELS_C0004: dynamicError,
    CHANNELS_C0005: dynamicError,
    CHANNELS_R0002: dynamicError,
    CHANNELS_R0003: dynamicError,
  },
})
