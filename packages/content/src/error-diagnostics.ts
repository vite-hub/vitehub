import { defineDiagnostics } from "nostics"

export const contentErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    CONTENT_R0001: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0002: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0003: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0004: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0005: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0006: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0007: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0008: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0009: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0010: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0011: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0012: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0013: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0014: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0015: {
      fix: "Start `vite dev` in this project, or pass `--url <origin>` of a running or deployed app. `VITEHUB_DEV_SERVER_URL` also names a server.",
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0016: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
    CONTENT_R0017: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
  },
})
