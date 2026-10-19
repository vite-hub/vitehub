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
  },
})
