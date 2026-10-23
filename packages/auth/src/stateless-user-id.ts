import type { BetterAuthOptions } from "better-auth"

type UserOptions = NonNullable<BetterAuthOptions["user"]>
type ValidateUserInfo = NonNullable<UserOptions["validateUserInfo"]>
type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>
type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>
type EndpointContext = Parameters<ValidateUserInfo>[1]

// Better Auth checks a new OAuth user with `validateUserInfo` and then creates it, in the same endpoint context.
const pendingUserIds = new WeakMap<object, string>()

/** The user ID of one provider account: the first 32 hex digits of SHA-256 over the provider ID and the account ID. */
export async function statelessUserId(providerId: string, accountId: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(["vitehub:auth:user", providerId, accountId]))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  return Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
}

/** The account ID that Better Auth stores for this provider profile, from the provider's own `accountSubject`. */
async function accountSubject(context: EndpointContext, providerId: string, profile: Record<string, unknown>): Promise<string | undefined> {
  const provider = context.context.socialProviders.find(candidate => candidate.id === providerId)
  // Every built-in provider reads the subject from the profile only. Better Auth does not pass the tokens here.
  const subject = await provider?.accountSubject({ profile, tokens: {} })
  return subject === undefined || subject === null || String(subject).trim() === "" ? undefined : String(subject)
}

/**
 * Without a database, Better Auth creates a new user at each sign-in. These hooks give that user an ID derived from
 * the provider account, so the same account gets the same `user.id` on every sign-in, instance, and restart.
 * They wrap the application's own `user.validateUserInfo` and `databaseHooks.user.create.before`.
 */
export function withStatelessUserId(options: { databaseHooks?: unknown, user?: unknown }): Pick<BetterAuthOptions, "databaseHooks" | "user"> {
  // SAFETY: These are the application's Better Auth options; the stateless preset only reads the two hooks that it wraps.
  const user = (options.user ?? {}) as UserOptions
  const databaseHooks = (options.databaseHooks ?? {}) as DatabaseHooks
  const validateUserInfo = user.validateUserInfo
  const createBefore = databaseHooks.user?.create?.before

  const validate: ValidateUserInfo = async (data, context) => {
    const { source } = data
    if (source.action === "create-user" && source.method === "oauth" && source.oauth) {
      const accountId = await accountSubject(context, source.oauth.providerId, source.oauth.profile ?? {})
      if (accountId === undefined) return { error: "vitehub_account_subject_missing", errorDescription: "The provider did not return an account ID." }
      pendingUserIds.set(context, await statelessUserId(source.oauth.providerId, accountId))
    }
    return validateUserInfo?.(data, context)
  }

  const before: UserCreateBefore = async (data, context) => {
    const result = createBefore ? await createBefore(data, context) : undefined
    const id = context ? pendingUserIds.get(context) : undefined
    if (result === false || id === undefined) return result
    if (context) pendingUserIds.delete(context)
    return { data: { ...(typeof result === "object" ? result.data : {}), id } }
  }

  return {
    databaseHooks: {
      ...databaseHooks,
      user: { ...databaseHooks.user, create: { ...databaseHooks.user?.create, before } },
    },
    user: { ...user, validateUserInfo: validate },
  }
}
