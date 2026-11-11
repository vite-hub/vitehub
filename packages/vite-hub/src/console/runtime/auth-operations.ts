/**
 * The Auth management operations of the Console. Each read and each action of the Auth section is one operation on the
 * Console RPC. Impersonation sets the app session cookie, so its operations return a one-time link that the browser
 * opens on the app origin.
 */
export const authConsoleReadOperations = {
  activity: "auth.activity",
  agents: "auth.agents",
  describe: "auth.describe",
  organization: "auth.organization",
  organizations: "auth.organizations",
  overview: "auth.overview",
  sessions: "auth.sessions",
  user: "auth.user",
  users: "auth.users",
} as const

export const authConsoleActionOperations = {
  ban: "auth.ban",
  editField: "auth.edit-field",
  remove: "auth.remove",
  revokeConsent: "auth.revoke-consent",
  revokeSession: "auth.revoke-session",
  revokeSessions: "auth.revoke-sessions",
  setRole: "auth.set-role",
  unban: "auth.unban",
} as const

/** The operations that return a one-time link to start or stop impersonation in the browser. */
export const authConsoleImpersonationOperations = {
  start: "auth.impersonate",
  stop: "auth.stop-impersonating",
} as const

export type AuthConsoleReadName = keyof typeof authConsoleReadOperations
export type AuthConsoleOperationAction = keyof typeof authConsoleActionOperations
