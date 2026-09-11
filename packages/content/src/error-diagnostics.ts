import { defineDiagnostics } from "nostics"

export const contentErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    CONTENT_R0005: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
  },
})
