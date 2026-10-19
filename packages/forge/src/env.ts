import type { ForgeKind } from "./provider.ts"

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
} satisfies Record<ForgeKind, Record<string, ForgeEnvField>>
