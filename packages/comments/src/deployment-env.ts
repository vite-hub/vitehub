import { parseDatabaseLocation } from "@vite-hub/database/config"

import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { CommentsOptions } from "./live-vite.ts"

const owners = ["comments"]

// The runtime modules that own these names load Better Auth, the libSQL client, and every Forge, so the Vite plugin
// does not import them. `test/deployment-env.test.ts` checks that they match `githubLoginEnv` in
// `runtime/github-login.ts`, `forgeEnv.github` in `@vite-hub/forge`, and `@vite-hub/database/connect`.
const githubLoginNames = { clientId: "VITEHUB_GITHUB_CLIENT_ID", clientSecret: "VITEHUB_GITHUB_CLIENT_SECRET" }
const forgeNames = [
  { names: ["VITEHUB_GITHUB_APP_ID", "FORGES_GITHUB_APP_ID"], secret: false },
  { names: ["VITEHUB_GITHUB_INSTALLATION_ID", "FORGES_GITHUB_INSTALLATION_ID"], secret: false },
  { names: ["VITEHUB_GITHUB_APP_OWNER"], secret: false },
  { names: ["VITEHUB_GITHUB_APP_INSTALLATIONS"], secret: false },
  { names: ["VITEHUB_GITHUB_PRIVATE_KEY", "FORGES_GITHUB_PRIVATE_KEY"], secret: true },
  { names: ["VITEHUB_GITHUB_PRIVATE_KEY_PATH"], secret: false },
  { names: ["VITEHUB_GITHUB_TOKEN", "FORGES_GITHUB_TOKEN"], secret: true },
]
const defaultDatabaseUrls = ["DATABASE_URL", "TURSO_DATABASE_URL"]

/** `TURSO_DATABASE_URL` → `TURSO_AUTH_TOKEN`, as `authTokenVariable()` in `@vite-hub/database/connect`. */
function databaseAuthTokenVariable(urlVariable: string): string {
  const name = urlVariable.replace(/(?:_DATABASE)?_URL$/, "_AUTH_TOKEN")
  return name === urlVariable ? `${urlVariable}_AUTH_TOKEN` : name
}

function entry(names: readonly string[], required: boolean, secret: boolean): DeploymentEnvEntry {
  return { names, required, secret, hasDefault: false, owners }
}

/** The database of `comments({ database })`: an `env:` variable and its token, or the default URL variables. */
function standaloneDatabaseEntries(where: string | undefined, host: DeploymentEnvContext["host"]): DeploymentEnvEntry[] {
  const location = parseDatabaseLocation(where, "comments")
  if (location.kind === "env") return [entry([location.name], true, true), entry([databaseAuthTokenVariable(location.name)], false, true)]
  if (location.kind !== "auto") return []
  // Without a location, a Worker falls back to the D1 binding `DB`. Other hosts need a URL.
  return [
    entry(defaultDatabaseUrls, host !== "cloudflare", true),
    ...defaultDatabaseUrls.map(name => entry([databaseAuthTokenVariable(name)], false, true)),
  ]
}

/**
 * The variables that Comments reads on the deployed host. Without Auth, Sign in with GitHub reads the OAuth client and
 * `VITEHUB_SECRET`, and stays off until they are set. `defineComments({ forge })` reads the GitHub App or token
 * credentials. `comments({ database })` reads its URL variable. With `vite-hub`, the threads live in a Database
 * Definition, which declares its own variables.
 */
export function commentsDeploymentEnv(options: { auth?: boolean, standalone?: CommentsOptions }, context: DeploymentEnvContext): DeploymentEnvEntry[] {
  return [
    ...options.auth ? [] : [
      entry([githubLoginNames.clientId], false, false),
      entry([githubLoginNames.clientSecret], false, true),
      entry(["VITEHUB_SECRET"], false, true),
    ],
    ...forgeNames.map(field => entry(field.names, false, field.secret)),
    ...options.standalone ? standaloneDatabaseEntries(options.standalone.database || undefined, context.host) : [],
  ]
}
