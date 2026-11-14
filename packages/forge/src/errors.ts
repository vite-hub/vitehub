import { defineErrors } from "@vite-hub/runtime"

// Keep published codes stable. Each code has a generated diagnostic page and a member in `ForgeErrorCode`.
export const forgeErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/forge/diagnostics",
  codes: {
    // Runtime errors. `useForge()` operations return them as `[error, undefined]`.
    FORGE_APP_NOT_INSTALLED: {
      why: ({ repository }: { repository: string }) => `The GitHub App is not installed on ${repository}.`,
      fix: "Install the GitHub App on the repository, or map its owner to an installation that can reach it in VITEHUB_GITHUB_APP_INSTALLATIONS.",
    },
    FORGE_REQUEST_FAILED: {
      why: ({ operation, status }: { operation: string, status?: number }) => status === undefined
        ? `${operation} failed.`
        : `${operation} failed with HTTP ${status}.`,
      fix: "Read `error.cause` for the Forge error. A 401 means that the App ID, the private key, or the token is wrong. Retry after a 5xx or a network error.",
    },

    // Config errors. `useForge()` throws them because the code or the deployment must change.
    FORGE_MISSING_ENV: {
      why: ({ forge, names }: { forge: string, names: string }) => `The ${forge} Forge has no credentials. It reads ${names}.`,
      fix: "Set the variables in the host environment, or pass `env` to `useForge()`.",
    },
    FORGE_INVALID_ENV: {
      why: ({ name, problem }: { name: string, problem: string }) => `${name} ${problem}.`,
      fix: "Correct the variable in the host environment.",
    },
    FORGE_MISSING_INSTALLATION: {
      why: "The GitHub App needs an installation. The call has no `repository`, and VITEHUB_GITHUB_INSTALLATION_ID is not set.",
      fix: "Pass `{ repository: 'owner/name' }`, or set VITEHUB_GITHUB_INSTALLATION_ID with VITEHUB_GITHUB_APP_OWNER.",
    },
    FORGE_NOT_APP: {
      why: "`forge.app()` needs a GitHub App, and this Forge uses a token.",
      fix: "Set VITEHUB_GITHUB_APP_ID with VITEHUB_GITHUB_PRIVATE_KEY or VITEHUB_GITHUB_PRIVATE_KEY_PATH, or check `forge.auth` before you call `app()`.",
    },
  },
})
