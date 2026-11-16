import { defineDiagnostics } from "nostics"

// The CMS keeps the Content codes of the `cms` preset, so its errors open the same docs.
export const cmsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/content/diagnostics",
  codes: {
    CONTENT_B0001: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "In the file that the message names, pass `extends: cms` or `extends: [cms, { ... }]` with string literal options that the message accepts.",
    },
    CONTENT_B0002: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "Set the `vitehub()` setting or the `cms` preset option that the message names, such as `vitehub({ database: true })` or `extends: [cms, { database: \"default\" }]`.",
    },
    CONTENT_R0006: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
    },
  },
})
