import { apiKey } from "@better-auth/api-key"
import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { jwt, lastLoginMethod, magicLink, organization, twoFactor } from "better-auth/plugins"
import { and, eq, isNull } from "drizzle-orm"
import { defineAuth } from "vite-hub/auth"
import { db, schema } from "vite-hub/database/drizzle"
import { send, sendsEmail } from "#mailer"
import { member, session } from "./databases/config"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { DEMO_LOCKED, DEMO_LOCKED_PATHS, isDemo, isDemoPerson, seedingEmails } from "./demo/mode"
import { isDemoEmail } from "../shared/demo"
import { isAllowedEmail } from "./utils/allowed"
import { DISABLED_AUTH_PATHS } from "./utils/disabled-auth-paths"
import { pendingInvitation, signUpRefusal } from "./utils/sign-up"
import { erasePeople, householdsOf } from "./utils/erase"
import { emailLanguage, requestLanguage } from "./utils/language"
import { translator } from "./utils/translate"
import { isLocale } from "../shared/locale"
import { CURRENCIES } from "../shared/money"
import * as v from "valibot"
import { createHousehold } from "./utils/household"

/**
 * Who can sign in, and how.
 *
 * Email and password, a passkey, or (when the build has Email) a magic link; two-factor is optional per person.
 * `FINANCE_ALLOWED_EMAILS` keeps a private ViteHub Finance private: only those emails, plus anyone a household invited, can sign up.
 * A password sign-up must belong to whoever reads that mailbox, or someone could claim an address (and the invitation
 * waiting for it) first: with Email, nobody signs in until the link sent to it is opened; without, it takes the
 * invitation link for that email, or being the instance's first person (`signUpRefusal`, server/utils/sign-up.ts).
 * The demo (`FINANCE_DEMO=1`) takes no sign-ups at all: only its seed creates its two made-up people.
 *
 * A household is a Better Auth organization. Signing up makes your own, unless an invitation is waiting for your
 * email: then /invite/<id> adds you to that household instead. Each session points at the household you're in. People
 * leave or are removed only through ViteHub Finance's endpoints (`DISABLED_AUTH_PATHS`, server/utils/disabled-auth-paths.ts).
 *
 * Nobody signs up under the demo's domain but the seed's own two (server/demo/seed.ts). Those two can't use the endpoints
 * that change who signs in or who's in the household (`DEMO_LOCKED_PATHS`, server/demo/mode.ts); everyone else can.
 *
 * Deleting your account erases the household with it, which is why it waits until nobody else is in that household.
 *
 * MCP clients connect through OAuth 2.1 (`oauthProvider`, tokens signed by `jwt`, scoped to `<origin>/mcp`). Scripts
 * that can't do OAuth use a personal API key (`apiKey`) as a bearer token instead.
 */
export default defineAuth(({ env, requestOrigin }) => ({
  appName: "ViteHub Finance",
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  user: {
    additionalFields: {
      language: { type: ["en", "es", "fr", "de", "pt"], required: false, input: true },
      // Better Auth checks neither value against its list, so the currency gets a validator; null follows the household.
      displayCurrency: { type: [...CURRENCIES], required: false, input: true, validator: { input: v.nullable(v.picklist(CURRENCIES)) } },
    },
    // Without a password or an email to confirm with, Better Auth wants a session signed in within the last day.
    deleteUser: {
      enabled: true,
      beforeDelete: async (person) => {
        const { shared } = await householdsOf([person.id])
        if (shared.length)
          throw new APIError("BAD_REQUEST", {
            message: "Leave your household, or remove its other members, before deleting your account.",
            code: "HOUSEHOLD_NOT_EMPTY",
          })
        await erasePeople([person.id], { keepLogin: true })
      },
    },
  },
  emailAndPassword: { enabled: true, minPasswordLength: 10, requireEmailVerification: sendsEmail },
  // Only a build with Email confirms addresses; without one, `signUpRefusal` decides (hooks.before).
  emailVerification: {
    sendOnSignUp: sendsEmail,
    // Signing in before confirming sends a fresh link.
    sendOnSignIn: sendsEmail,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user: person, url }, request) => {
      // The demo's people are made up (and created verified); nothing goes to their domain.
      if (isDemoEmail(person.email)) return
      const t = await translator(await emailLanguage(person.email, requestLanguage(request?.headers)))
      await send({ to: person.email, subject: t("emailVerifySubject"), text: t("emailVerifyBody", { url }) })
    },
  },
  disabledPaths: DISABLED_AUTH_PATHS,
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email" && !sendsEmail && !isDemo()) {
        const refusal = await signUpRefusal(ctx.body, env.finance.allowedEmails.unseal())
        if (refusal) throw new APIError("FORBIDDEN", refusal)
      }
      // The demo's people, and any request about one of their emails, can't change sign-in or households.
      if (!isDemo() || !DEMO_LOCKED_PATHS.has(ctx.path)) return
      const body = (ctx.body ?? {}) as { email?: unknown; newEmail?: unknown }
      const named = [body.email, body.newEmail].filter((value): value is string => typeof value === "string")
      if (named.some((email) => isDemoEmail(email) && !seedingEmails.has(email.toLowerCase()))) throw demoLocked()
      const current = await getSessionFromCtx(ctx).catch(() => null)
      if (isDemoPerson(current?.user.email)) throw demoLocked()
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (person, context) => {
          // The seed's made-up people count as verified, so the demo signs them in by password whether or not the build has Email.
          if (isDemoEmail(person.email)) return seedingEmails.has(person.email.toLowerCase()) ? { data: { ...person, emailVerified: true } } : false
          // The demo has only its two made-up people, so it never holds anyone's real data. A private instance is open to
          // its allowed emails and the people a household invited.
          if (isDemo()) return false
          if (!isAllowedEmail(person.email, env.finance.allowedEmails.unseal()) && !(await pendingInvitation(person.email))) return false
          const language = "language" in person && isLocale(person.language) ? person.language : requestLanguage(context?.headers)
          return { data: { ...person, language } }
        },
        // Invited people join the inviter's household from the invitation page; everyone else gets their own.
        after: async (person) => {
          if (await pendingInvitation(person.email)) return
          const householdId = await createHousehold(person)
          // Sign-up may open the session before this hook runs; point it at the new household.
          await db
            .update(session)
            .set({ activeOrganizationId: householdId })
            .where(and(eq(session.userId, person.id), isNull(session.activeOrganizationId)))
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: member.organizationId })
            .from(member)
            .where(eq(member.userId, session.userId))
            .orderBy(member.createdAt)
            .limit(1)
          return { data: { ...session, activeOrganizationId: membership?.organizationId ?? null } }
        },
      },
    },
  },
  plugins: [
    organization({
      // Households come from sign-up (server/utils/household.ts); people don't make more of them by hand.
      allowUserToCreateOrganization: false,
      creatorRole: "owner",
      invitationExpiresIn: 7 * 24 * 60 * 60,
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: async ({ id, email, inviter, organization: household }, request) => {
        const language = await emailLanguage(email, await emailLanguage(inviter.user.email, requestLanguage(request?.headers)))
        const t = await translator(language)
        await send({
          to: email,
          subject: t("emailInviteSubject", { name: inviter.user.name, household: household.name }),
          text: t("emailInviteBody", { name: inviter.user.name, url: `${requestOrigin}/invite/${id}` }),
        })
      },
    }),
    passkey({
      rpID: new URL(requestOrigin).hostname,
      rpName: "ViteHub Finance",
      origin: requestOrigin,
    }),
    twoFactor({ issuer: "ViteHub Finance" }),
    magicLink({
      sendMagicLink: async ({ email, url }, context) => {
        const t = await translator(await emailLanguage(email, requestLanguage(context?.headers)))
        await send({ to: email, subject: t("emailMagicSubject"), text: t("emailMagicBody", { url }) })
      },
    }),
    apiKey({
      defaultPrefix: "fin_",
      enableMetadata: true,
      rateLimit: { enabled: true, timeWindow: 60 * 1000, maxRequests: 120 },
    }),
    lastLoginMethod({ storeInDatabase: true }),
    jwt(),
    oauthProvider({
      loginPage: "/oauth",
      consentPage: "/oauth",
      codeExpiresIn: 30 * 60,
      scopes: ["openid", "profile", "email", "offline_access"],
      resources: [`${requestOrigin}/mcp`],
      enforcePerClientResources: false,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // MCP clients register loopback or private-use redirects without `application_type`; register them as native.
      clientRegistrationDefaultApplicationType: "infer",
    }),
  ],
}))

const demoLocked = () => new APIError("FORBIDDEN", { message: DEMO_LOCKED, code: "DEMO_LOCKED" })
