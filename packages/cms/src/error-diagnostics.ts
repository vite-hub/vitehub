import { defineDiagnostics } from "nostics"

export const cmsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/content/diagnostics",
  codes: {
    CONTENT_B0001: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "In the file that the message names, pass `extends: cms` or `extends: [cms, { ... }]` with literal options that the message accepts. Use the boolean literal `true` for `roles`.",
    },
    CONTENT_B0002: {
      why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
      fix: "Set the `vitehub()` setting or the `cms` preset option that the message names, such as `vitehub({ database: true })` or `extends: [cms, { database: \"default\" }]`.",
    },
    // Named errors.
    CONTENT_CMS_OPTION_INVALID: {
      docs: "https://vitehub.dev/docs/cms/diagnostics/content_cms_option_invalid",
      why: ({ problem }: { problem: string }) => `[vitehub] Content cms preset ${problem}`,
      fix: "Set each option of `extends: [cms, { ... }]` to a value that the message accepts. Use `repo`, `branch`, `draftBranch`, `root`, and `publish` only with the GitHub store, and `blob` only without it.",
    },
  },
})
