export interface InlineConsoleAuth {
  provider: "github"
  /** Verified email addresses that may sign in. With `org`, a user must pass both checks. */
  allowedEmails?: string[]
  /** GitHub organization logins. Sign-in requires active membership in one of them and a verified email. */
  org?: string | string[]
  /** Persistent SQLite file. Defaults to `<dataDir>/console-auth.sqlite` when `dataDir` is set. */
  databasePath?: string
  baseURL?: string
  client?: string
  clientIdEnv?: string
  clientSecretEnv?: string
  secretEnv?: string
  /** Better Auth session options. `expiresIn` is in seconds. */
  session?: { expiresIn?: number }
}

export interface InlineConsoleAuthGates {
  allowedEmails?: Set<string>
  databasePath: string
  orgs: string[]
}

const githubLogin = /^(?=.{1,39}$)[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*$/i

/** Validate inline Console Auth at build time and at runtime with the same rules. */
export function resolveInlineConsoleAuthGates(config: InlineConsoleAuth): InlineConsoleAuthGates {
  const orgs = config.org === undefined ? [] : [config.org].flat()
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Inline config crosses the JSON-serialized Vite config boundary, so verify each organization login.
  if ((config.org !== undefined && orgs.length === 0) || orgs.some(org => typeof org !== "string" || !githubLogin.test(org))) {
    throw new TypeError("[vitehub] Inline Console Auth org must be a GitHub organization login.")
  }
  if (config.allowedEmails !== undefined && (!Array.isArray(config.allowedEmails) || config.allowedEmails.length === 0)) {
    throw new TypeError("[vitehub] Inline Console Auth allowedEmails must be a non-empty list.")
  }
  if (config.provider !== "github" || (!config.allowedEmails && orgs.length === 0)) {
    throw new TypeError("[vitehub] Inline Console Auth requires provider: 'github' and allowedEmails, org, or both.")
  }
  if (!config.databasePath || config.databasePath === ":memory:") {
    throw new TypeError("[vitehub] Inline Console Auth requires a persistent databasePath. Set databasePath or dataDir.")
  }
  const gates: InlineConsoleAuthGates = { databasePath: config.databasePath, orgs }
  if (config.allowedEmails) gates.allowedEmails = new Set(config.allowedEmails.map(email => email.toLowerCase()))
  return gates
}
