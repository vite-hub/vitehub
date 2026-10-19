import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const forgeDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/diagnostics",
  codes: {
    /** The GitHub App installation lookup failed or the App is not installed. */
    FORGE_R0001: dynamicError,
    /** `forgeArchive()` was called for a Forge without archive support. */
    FORGE_R0002: dynamicError,
    /** `forgeGitCredentials()` received an invalid base URL or repository. */
    FORGE_R0003: dynamicError,
    /** `forgeBlob()` was called for a Forge without blob reads. */
    FORGE_R0004: dynamicError,
    /** `forgeCommitFiles()` received a file mode for a Forge without file mode writes. */
    FORGE_R0005: dynamicError,
    /** A GitHub-only Forge helper received a provider for another Forge. */
    FORGE_R0006: dynamicError,
    /** GitHub did not return complete branch rules, rulesets or classic protection. */
    FORGE_R0007: dynamicError,
    /** GitHub did not return complete review threads. */
    FORGE_R0008: dynamicError,
    /** A GitHub-only Forge helper received a reference that is not a numbered pull request, or an empty input. */
    FORGE_R0009: dynamicError,
  },
})
