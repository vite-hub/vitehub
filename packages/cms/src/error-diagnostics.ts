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
    // Named errors. Each names what failed. Keep them in alphabetical order.
    CONTENT_CMS_OPTION_INVALID: {
      why: ({ problem }: { problem: string }) => `[vitehub] Content cms preset ${problem}`,
      fix: "Set each option of `extends: [cms, { ... }]` to a value that the message accepts. Use `repo`, `branch`, `draftBranch`, `root`, and `publish` only with the GitHub store, and `blob` only without it.",
    },
  },
})
