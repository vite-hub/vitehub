import { and, eq } from "drizzle-orm"
import { db } from "vite-hub/database/drizzle"
import { account, user as users } from "../databases/config"
import { useServerEnv } from "#vitehub/env/server"
import { isListed } from "#shared/roles"
import { githubOrganization, isGitHubMember } from "./github-membership"

/** Whether only some people may use this Drop: those `DROP_MEMBERS` lists, `DROP_GITHUB_ORG`'s members, or both. */
export const membersOnly = () => Boolean(useServerEnv().drop.members.unseal().trim() || githubOrganization())

/**
 * Whether `DROP_MEMBERS` lets this person in: it's empty, or it or `DROP_ADMINS` has their email, verified by the
 * sign-in method. Like for admins, any sign-in method counts (GitHub, another provider, email), so the list doesn't
 * change when the provider does. In `nuxt dev` and with `DROP_TEST_SIGNIN`, an unverified email counts too.
 */
export function isListedMember(person: { email: string; emailVerified?: boolean | null }) {
  const { members, admins, testSignin } = useServerEnv().drop
  const list = members.unseal()
  if (!list.trim()) return true
  return isListed(person, `${list},${admins.unseal()}`, import.meta.dev === true || testSignin)
}

/**
 * Whether someone may still use this Drop, checked on every request: `DROP_MEMBERS` lists them and they're an active
 * member of `DROP_GITHUB_ORG`, for each of the two that's set. Taking someone off the list locks them out on restart;
 * a lost organization membership, within five minutes.
 */
export async function isMember(userId: string) {
  if (!membersOnly()) return true
  const [row] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row || !isListedMember(row)) return false
  if (!githubOrganization()) return true
  const [github] = await db
    .select({ token: account.accessToken })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1)
  return isGitHubMember(github?.token)
}
