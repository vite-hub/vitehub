import { defineErrors } from "@vite-hub/runtime"
import { APIError } from "better-auth/api"
import { decryptOAuthToken } from "better-auth/oauth2"
import { adminRoleGrant } from "./admins.ts"
import { checkGitHubOrgMember } from "./github.ts"
import { authCloudflareEnv } from "./request.ts"

import type { ViteHubContext } from "@vite-hub/runtime"
import type { Account, AuthContext, BetterAuthOptions, BetterAuthPlugin, User } from "better-auth"
import type { AdminAccount } from "./admins.ts"

/** The variable that lists who may sign up and sign in. */
export const membersVariable = "VITEHUB_MEMBERS"

/** One `VITEHUB_MEMBERS` entry. */
export type MemberEntry =
  | { kind: "account", providerId: string, accountId: string }
  | { kind: "email", email: string }
  | { kind: "domain", domain: string }
  | { kind: "github-org", org: string }

// Keep published codes stable. The docs build writes a page for each code.
const memberErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/auth/diagnostics",
  codes: {
    // Config errors. Auth throws them when it reads `VITEHUB_MEMBERS`, so every request fails until the host is fixed.
    AUTH_MEMBERS_ENTRY_INVALID: {
      why: ({ entry, reason }: { entry: string, reason: string }) => `\`VITEHUB_MEMBERS\` has the entry \`${entry}\`. ${reason}`,
      fix: "Separate the entries with commas. Write each entry as `github:<account id>`, `<email>`, `@<email domain>`, or `github-org:<organization login>`, for example `VITEHUB_MEMBERS=github:22072217,ada@example.com,@acme.com,github-org:acme`. Run `gh api users/<login> --jq .id` to get a GitHub account id.",
    },
    AUTH_MEMBERS_SESSION_STORE_REQUIRED: {
      why: "`VITEHUB_MEMBERS` is set, but Auth has no Better Auth `database` or `secondaryStorage` adapter. Auth cannot end the session of a person who leaves the list when the session lives only in a cookie.",
      fix: "Set `database: authDatabase()` with `import { authDatabase } from '@vite-hub/auth/database'`, or return another Better Auth adapter. Or unset `VITEHUB_MEMBERS`.",
    },

    // Runtime error. A refused sign-up or sign-in answers `403` with this code. An OAuth sign-in redirects with `?error=AUTH_NOT_MEMBER`.
    AUTH_NOT_MEMBER: {
      why: "`VITEHUB_MEMBERS` does not list this account, its verified email, its email domain, or a GitHub organization that it is an active member of.",
      fix: "Add the person to `VITEHUB_MEMBERS` on the host, for example `github:22072217` or `ada@example.com`, and ask them to sign in again. An email or domain entry matches only an email that the sign-in provider verified.",
    },
  },
})

function invalidEntry(entry: string, reason: string): Error {
  return memberErrors.AUTH_MEMBERS_ENTRY_INVALID({ entry, reason })
}

function parseEntry(entry: string): MemberEntry {
  if (entry.startsWith("@")) {
    const domain = entry.slice(1).toLowerCase()
    if (!domain || domain.includes("@")) throw invalidEntry(entry, "A domain entry is `@` and the email domain, such as `@acme.com`.")
    return { kind: "domain", domain }
  }
  if (entry.includes("@") && !entry.includes(":")) {
    if (entry.indexOf("@") !== entry.lastIndexOf("@")) throw invalidEntry(entry, "An email has one `@`.")
    return { kind: "email", email: entry.toLowerCase() }
  }
  const separator = entry.indexOf(":")
  const providerId = separator > 0 ? entry.slice(0, separator).trim().toLowerCase() : ""
  const value = separator > 0 ? entry.slice(separator + 1).trim() : ""
  if (!providerId || !value) throw invalidEntry(entry, "It is not an email, a domain, or `<provider>:<account id>`.")
  if (providerId === "github-org") return { kind: "github-org", org: value }
  if (providerId === "email" || providerId === "credential") throw invalidEntry(entry, "Write an email entry as the email alone, such as `ada@example.com`.")
  // A GitHub login can change, and someone else can take the old one. The numeric id stays with the account.
  if (providerId === "github" && !/^\d+$/.test(value)) throw invalidEntry(entry, "A GitHub entry needs the numeric account id, not the login.")
  return { kind: "account", providerId, accountId: value }
}

/** The entries of `VITEHUB_MEMBERS`, separated by commas. An unset or empty variable lets everyone in. */
export function readMembers(event?: ViteHubContext): MemberEntry[] {
  const env: Record<string, unknown> = { ...globalThis.process?.env, ...authCloudflareEnv(event) }
  const value = env[membersVariable]
  if (typeof value !== "string") return []
  return value.split(",").map(entry => entry.trim()).filter(Boolean).map(parseEntry)
}

export function formatMemberEntry(entry: MemberEntry): string {
  switch (entry.kind) {
    case "account": return `${entry.providerId}:${entry.accountId}`
    case "email": return entry.email
    case "domain": return `@${entry.domain}`
    case "github-org": return `github-org:${entry.org}`
  }
}

/** Fails when `VITEHUB_MEMBERS` is set but Auth stores no sessions. */
export function assertMembersSessionStore(members: readonly MemberEntry[], hasSessionStore: boolean): void {
  if (members.length && !hasSessionStore) throw memberErrors.AUTH_MEMBERS_SESSION_STORE_REQUIRED()
}

/** The GitHub provider asks for `read:org` when an entry names a GitHub organization, so Auth can check the membership. */
export function withMemberScopes(
  members: readonly MemberEntry[],
  socialProviders: BetterAuthOptions["socialProviders"],
): BetterAuthOptions["socialProviders"] {
  const github = socialProviders?.github
  if (!github || !members.some(entry => entry.kind === "github-org")) return socialProviders
  const withReadOrg = <T extends { scope?: string[] }>(options: T): T =>
    options.scope?.includes("read:org") ? options : { ...options, scope: [...options.scope ?? [], "read:org"] }
  return { ...socialProviders, github: typeof github === "function" ? async () => withReadOrg(await github()) : withReadOrg(github) }
}

/** The answer that Auth sends for a refused sign-up or sign-in. */
function notMember(): APIError {
  const error = memberErrors.AUTH_NOT_MEMBER()
  return new APIError("FORBIDDEN", { code: error.code, message: error.why })
}

type MemberUser = Pick<User, "id" | "email" | "emailVerified"> & Record<string, unknown>
type MemberAccount = Pick<Account, "providerId" | "accountId" | "accessToken">

export interface MembersGate {
  /** The entries as `VITEHUB_MEMBERS` writes them, for the Console. */
  entries: readonly string[]
  /**
   * Whether the list lets `user` in now: a verified email or its domain, a linked account, a listed admin, the admin
   * role, or an active membership of a listed GitHub organization. Throws when GitHub cannot answer.
   */
  allows: (context: AuthContext, user: MemberUser) => Promise<boolean>
  /** Refuses the sign-up of a person that the list cannot let in. */
  databaseHooks: (context: AuthContext) => NonNullable<BetterAuthOptions["databaseHooks"]>
  /** The error to throw for a refused sign-in. */
  refusal: () => APIError
}

/**
 * Builds the check of `VITEHUB_MEMBERS`. The accounts in `VITEHUB_ADMINS` and users with the admin role of `admin()`
 * are always members.
 */
export function createMembersGate(members: readonly MemberEntry[], admins: readonly AdminAccount[], plugins: readonly BetterAuthPlugin[]): MembersGate {
  const accounts = [...members.flatMap(entry => entry.kind === "account" ? [entry] : []), ...admins]
  const orgs = members.flatMap(entry => entry.kind === "github-org" ? [entry.org] : [])
  const adminRole = plugins.some(plugin => plugin.id === "admin") ? adminRoleGrant(plugins, membersVariable).role : undefined

  const emailListed = (email: string) => {
    const address = email.toLowerCase()
    return members.some(entry => (entry.kind === "email" && entry.email === address) || (entry.kind === "domain" && address.endsWith(`@${entry.domain}`)))
  }
  const accountListed = (account: MemberAccount) => accounts.some(entry => entry.providerId === account.providerId && entry.accountId === account.accountId)

  const orgMember = async (context: AuthContext, account: MemberAccount) => {
    if (account.providerId !== "github" || !account.accessToken || !orgs.length) return false
    const token = await decryptOAuthToken(account.accessToken, context)
    for (const org of orgs) {
      const [error] = await checkGitHubOrgMember(token, org)
      if (!error) return true
      // A GitHub outage must not let anyone in, and must not end a session either: the request fails instead.
      if (error.code === "AUTH_GITHUB_UNAVAILABLE") throw new APIError("SERVICE_UNAVAILABLE", { code: error.code, message: error.why })
    }
    return false
  }

  const allows = async (context: AuthContext, user: MemberUser) => {
    if (user.emailVerified && emailListed(user.email)) return true
    const role = user.role
    if (adminRole && typeof role === "string" && role.split(",").some(name => name.trim() === adminRole)) return true
    const linked = await context.internalAdapter.findAccounts(user.id)
    if (linked.some(accountListed)) return true
    for (const account of linked) if (await orgMember(context, account)) return true
    return false
  }

  return {
    entries: members.map(formatMemberEntry),
    allows,
    refusal: notMember,
    databaseHooks: context => ({
      user: {
        create: {
          // Better Auth creates the user before its first account, so an account or organization entry decides then.
          before: async (user) => {
            if (!emailListed(user.email) && !accounts.length && !orgs.length) throw notMember()
          },
        },
      },
      account: {
        create: {
          // The first account of a user is a sign-up. Linking another account to a member is not checked.
          // The email can be unverified here: Auth creates no session until the email is verified.
          before: async (account) => {
            if ((await context.internalAdapter.findAccounts(account.userId)).length) return
            const user = await context.internalAdapter.findUserById(account.userId)
            let allowed = Boolean(user && emailListed(user.email)) || accountListed(account)
            try {
              allowed ||= await orgMember(context, account)
            }
            finally {
              // Without a transaction, Better Auth would keep the user of a refused sign-up.
              if (!allowed && user) await context.internalAdapter.deleteUser(user.id)
            }
            if (!allowed) throw notMember()
          },
        },
      },
    }),
  }
}
