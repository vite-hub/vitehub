import { internalErrorDiagnostics } from "./error-diagnostics.ts"

/**
 * The Server Env names of each Forge, and the HTTP status of a failed Forge request. `@vite-hub/forge` exports them.
 * Channels and Workspaces import them from here, so an app without a Forge does not install or bundle `@vite-hub/forge`.
 */

/** One Server Env value of a Forge. */
export interface ForgeEnvField {
  /** Host variable names in lookup order. The `VITEHUB_` name comes first, then the `forges` name. */
  names: readonly [string, ...string[]]
  secret?: true
}

/** Server Env fields of each Forge. */
export type ForgeEnv = {
  github: Record<"appId" | "installationId" | "appOwner" | "appInstallations" | "privateKey" | "privateKeyPath" | "token" | "webhookSecret", ForgeEnvField>
  gitlab: Record<"baseUrl" | "token" | "webhookSecret", ForgeEnvField>
  forgejo: Record<"baseUrl" | "token" | "webhookSecret", ForgeEnvField>
}

/**
 * Server Env of each Forge, keyed by the `env.server.<forge>.<field>` path.
 * Channels, Capabilities, Workspaces and Sources read the same names.
 * `FORGES_*` names are the ones that `forgesFromEnv()` in the `forges` library reads.
 * Fields without a `forges` equivalent have only a `VITEHUB_` name.
 */
export const forgeEnv: ForgeEnv = {
  github: {
    appId: { names: ["VITEHUB_GITHUB_APP_ID", "FORGES_GITHUB_APP_ID"] },
    installationId: { names: ["VITEHUB_GITHUB_INSTALLATION_ID", "FORGES_GITHUB_INSTALLATION_ID"] },
    appOwner: { names: ["VITEHUB_GITHUB_APP_OWNER"] },
    appInstallations: { names: ["VITEHUB_GITHUB_APP_INSTALLATIONS"] },
    privateKey: { names: ["VITEHUB_GITHUB_PRIVATE_KEY", "FORGES_GITHUB_PRIVATE_KEY"], secret: true },
    privateKeyPath: { names: ["VITEHUB_GITHUB_PRIVATE_KEY_PATH"] },
    token: { names: ["VITEHUB_GITHUB_TOKEN", "FORGES_GITHUB_TOKEN"], secret: true },
    webhookSecret: { names: ["VITEHUB_GITHUB_WEBHOOK_SECRET", "FORGES_GITHUB_WEBHOOK_SECRET"], secret: true },
  },
  gitlab: {
    baseUrl: { names: ["VITEHUB_GITLAB_BASE_URL", "FORGES_GITLAB_BASE_URL"] },
    token: { names: ["VITEHUB_GITLAB_TOKEN", "FORGES_GITLAB_TOKEN"], secret: true },
    webhookSecret: { names: ["VITEHUB_GITLAB_WEBHOOK_SECRET", "FORGES_GITLAB_WEBHOOK_SECRET"], secret: true },
  },
  forgejo: {
    baseUrl: { names: ["VITEHUB_FORGEJO_BASE_URL", "FORGES_FORGEJO_BASE_URL"] },
    token: { names: ["VITEHUB_FORGEJO_TOKEN", "FORGES_FORGEJO_TOKEN"], secret: true },
    webhookSecret: { names: ["VITEHUB_FORGEJO_WEBHOOK_SECRET", "FORGES_FORGEJO_WEBHOOK_SECRET"], secret: true },
  },
}

/**
 * The first value of `field` that is set, in its lookup order.
 * `env` is a record, such as `process.env`, or a reader, such as a Cloudflare binding lookup. Default: `process.env`.
 */
export function readForgeEnv(field: ForgeEnvField, env: Record<string, unknown> | ((name: string) => unknown) = globalThis.process?.env ?? {}): string | undefined {
  for (const name of field.names) {
    const value: unknown = typeof env === "function" ? env(name) : env[name]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
}

/** The HTTP status of a failed Forge request, or undefined for other errors. */
export function forgeErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("status" in error)) return undefined
  return typeof error.status === "number" ? error.status : undefined
}

/**
 * The error for a failed `import("@vite-hub/forge")`, an optional peer of Channels, Workspaces, and Sources. When the
 * app did not install Forge, it is a coded error that names the install command. Otherwise it is the load error itself.
 * `feature` names what needs Forge, such as `A GitHub Workspace`.
 *
 * Call it in the `catch` of a `try` that holds the import itself, in the calling package. esbuild, and so Wrangler and
 * Netlify, then keep an import that does not resolve for run time instead of failing the build.
 */
export function forgeImportError(error: unknown, feature: string): unknown {
  if (!isMissingForge(error)) return error
  return internalErrorDiagnostics.INTERNAL_FORGE_NOT_INSTALLED({ cause: error, feature })
}

// Node: Cannot find package '@vite-hub/forge'. workerd: No such module "@vite-hub/forge". A Vite build without the
// optional peer: Could not resolve "@vite-hub/forge". A missing dependency of Forge itself names that dependency, so it
// stays a plain load error.
function isMissingForge(error: unknown): boolean {
  return error instanceof Error && /(?:cannot find (?:package|module)|no such module|could not resolve) ['"]@vite-hub\/forge['"]/i.test(error.message)
}
