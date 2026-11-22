import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

export const forgeDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/forge/diagnostics",
  codes: {
    FORGE_R0001: { ...dynamicError, fix: "Install the GitHub App on the repository that the message names, and check that the app credentials can read it. For a failed request, `error.cause` holds the GitHub answer." },
    FORGE_R0002: { ...dynamicError, fix: "Call `forgeArchive()` with a GitHub provider, because other forges have no archive download here." },
    FORGE_R0003: { ...dynamicError, fix: "Pass a forge base URL that starts with `https://` or `http://`, and a repository as `owner/name`." },
    FORGE_R0004: { ...dynamicError, fix: "Call `forgeBlob()` with a GitHub provider, because other forges cannot read a blob by sha here." },
    FORGE_R0005: { ...dynamicError, fix: "Remove `mode` from the file changes, or commit them with a GitHub provider." },
    FORGE_R0006: { ...dynamicError, fix: "Call the helper that the message names with a GitHub provider." },
    FORGE_R0007: { ...dynamicError, fix: "Read the branch rules with a GitHub token that can read the branch protection and rulesets of the repository, and pass the result of `provider.repos.branchRules()` unchanged." },
    FORGE_R0009: { ...dynamicError, fix: "Pass a pull request thread with a `number` and a nonempty base branch. For `forgeMerge({ bypassRules })`, also pass `method` and `sha`." },
    // Named errors.
    FORGE_RESPONSE_INVALID: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Check that the GitHub App, the token, or the forge webhook can read the resource that the message names, then retry. A retry helps when the forge was only unavailable.",
    },
    FORGE_UNSUPPORTED: {
      why: "Unsupported Forge.",
      fix: "Set `forge` of the Forge connection to `github`, `gitlab`, `forgejo`, or `gitea`.",
    },
  },
})
