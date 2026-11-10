import type { GenericEndpointContext } from "better-auth"

/**
 * People who sign up with only a passkey have no email address. Better Auth needs one, so the Console gives them an
 * address on the reserved `.invalid` domain (RFC 2606). Nothing is sent to it, and no invitation can match it.
 */
export const passkeyEmailDomain = "passkey.invalid"

export function isPasskeyEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${passkeyEmailDomain}`)
}

/** The name of a new account, from the `context` that the sign-up page sends. Empty names get a default. */
export function accountName(context: string | null | undefined): string {
  const name = (context ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
  return name || "ViteHub user"
}

/** Every account has a personal team, like Executor. The slug is the user id, so it cannot collide. */
export function personalTeam(userId: string): { name: string, slug: string } {
  return { name: "Personal", slug: `personal-${userId.toLowerCase()}` }
}

interface Row { id: string, organizationId?: string }

/**
 * The team that a new session opens: the person's first team. Someone without a team, such as after the first
 * sign-in, gets a personal team, with the person as its `owner`.
 */
export async function sessionTeam(userId: string, context: GenericEndpointContext | null): Promise<string | undefined> {
  if (!context) return undefined
  const adapter = context.context.adapter
  const [membership] = await adapter.findMany<Row>({ model: "member", where: [{ field: "userId", value: userId }], sortBy: { field: "createdAt", direction: "asc" }, limit: 1 })
  if (membership?.organizationId) return membership.organizationId
  const now = new Date()
  const team = await adapter.create<Record<string, unknown>, Row>({ model: "organization", data: { ...personalTeam(userId), createdAt: now } })
  await adapter.create({ model: "member", data: { organizationId: team.id, userId, role: "owner", createdAt: now } })
  return team.id
}

/**
 * Passkey sign-up: the first passkey makes the account. `resolveUser` gives the browser a provisional id and the name
 * that the person typed. After the browser proves the new passkey, `afterVerification` creates the user, and the
 * passkey and the session belong to it.
 */
export const passkeySignUp = {
  requireSession: false,
  resolveUser({ context }: { context?: string | null }) {
    return { id: crypto.randomUUID(), name: accountName(context) }
  },
  async afterVerification({ ctx, user }: { ctx: GenericEndpointContext, user: { id: string, name: string } }) {
    // A signed-in person adds a passkey to the account they have. Better Auth then resolved the user from the session.
    if (await ctx.context.internalAdapter.findUserById(user.id)) return {}
    const created = await ctx.context.internalAdapter.createUser({ email: `${user.id}@${passkeyEmailDomain}`, emailVerified: false, name: user.name }, { method: "passkey" })
    return { userId: created.id }
  },
}

interface LinkedAccount { userId: string, providerId: string, accessToken?: string | null }

/**
 * A passkey account that links GitHub takes the verified primary email of that GitHub account, so invitations sent to
 * it can match. Better Auth keeps the local email on a link on purpose, so the Console replaces only its own
 * `passkey.invalid` placeholder, and only with an email that no other account has.
 */
export async function adoptGitHubEmail(account: LinkedAccount, context: GenericEndpointContext | null, fetcher: typeof fetch = fetch): Promise<void> {
  if (!context || account.providerId !== "github" || !account.accessToken) return
  // The link is saved before this runs. The email is extra, so a failure here must not fail the link.
  try {
    const internal = context.context.internalAdapter
    const user = await internal.findUserById(account.userId)
    if (!user || !isPasskeyEmail(user.email)) return
    const response = await fetcher("https://api.github.com/user/emails", {
      headers: { "accept": "application/vnd.github+json", "authorization": `Bearer ${account.accessToken}`, "user-agent": "ViteHub Console" },
    })
    if (!response.ok) return
    const emails: unknown = await response.json()
    const primary = Array.isArray(emails) ? emails.find(entry => entry instanceof Object && Reflect.get(entry, "primary") === true && Reflect.get(entry, "verified") === true) : undefined
    const address: unknown = primary instanceof Object ? Reflect.get(primary, "email") : undefined
    if (String(address) !== address || !address.includes("@")) return
    const email = address.toLowerCase()
    if (await internal.findUserByEmail(email)) return
    await internal.updateUser(account.userId, { email, emailVerified: true })
  }
  catch (error) {
    context.context.logger.warn("The Console could not copy the GitHub email to a passkey account.", error)
  }
}
