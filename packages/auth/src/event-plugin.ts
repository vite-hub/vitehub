import { AsyncLocalStorage } from "node:async_hooks"
import { APIError } from "better-auth"
import { createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sensitiveSessionMiddleware } from "better-auth/api"
import type { BetterAuthPlugin, GenericEndpointContext, SecondaryStorage } from "better-auth"
import { parseAuthEventList, parseAuthEventWindow } from "./events.ts"
import type { AuthDevice, AuthEventActor, AuthEventListInput, AuthEventMetadata, AuthEventsConfiguration, AuthEventType } from "./events.ts"

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined
}
function actor(ctx: GenericEndpointContext | null, fallback?: string): AuthEventActor {
  const session = ctx?.context.session
  const id = identifier(session?.session.impersonatedBy) ?? session?.user.id ?? fallback
  return id ? `user:${id}` : "system"
}
function method(ctx: GenericEndpointContext | null): string {
  const path = ctx?.path ?? ""
  const providers = ctx?.context.socialProviders ?? []
  const candidate = path.startsWith("/callback/") || path.startsWith("/oauth2/callback/")
    ? path.split("/").at(-1) : identifier(record(ctx?.body).provider)
  if (candidate && providers.some(provider => provider.id === candidate) && /^[a-zA-Z0-9_.-]+$/.test(candidate)) return `oauth:${candidate}`
  if (path === "/sign-in/email" || path === "/sign-up/email") return "email-password"
  if (path.includes("/magic-link/verify")) return "magic-link"
  if (path.includes("/passkey/verify-authentication")) return "passkey"
  if (path.startsWith("/two-factor/")) return "two-factor"
  if (path.includes("/siwe/")) return "siwe"
  for (const name of ["email-otp", "username", "phone-number", "anonymous"]) if (path === `/sign-in/${name}`) return name
  return "unknown"
}
/** Discard the raw agent string. IP addresses are never read. */
export function authEventDevice(agent: string | null | undefined): AuthDevice {
  if (!agent) return "unknown"
  if (/bot|crawler|spider/i.test(agent)) return "bot"
  if (/ipad|tablet/i.test(agent) || /android/i.test(agent) && !/mobile/i.test(agent)) return "tablet"
  if (/mobi|iphone|ipod/i.test(agent)) return "mobile"
  if (/windows|macintosh|linux|cros/i.test(agent)) return "desktop"
  return "unknown"
}

/** Compose with Better Auth's own hook pipeline, including direct auth.api calls. */
export function createAuthEventsPlugin(options: AuthEventsConfiguration): BetterAuthPlugin & { captureOutcome: (ctx: unknown) => void, wrapStorage: (storage: SecondaryStorage) => SecondaryStorage } {
  const deletionContext = new AsyncLocalStorage<GenericEndpointContext>()
  const outcomes = new WeakMap<object, unknown>()
  const challenges = new WeakSet<object>()
  const wrappedAdapters = new WeakSet<object>()
  const createdSessions = new WeakSet<object>()
  const recordedSessions = new WeakSet<object>()
  async function append(type: AuthEventType, userId: string | null, ctx: GenericEndpointContext | null, metadata: AuthEventMetadata = {}, fallback?: string) {
    try {
      await options.store.append({ id: crypto.randomUUID(), type, time: new Date().toISOString(), actor: actor(ctx, fallback), userId, metadata })
    }
    catch {
      // Auth mutations may already be committed. Do not turn a completed sign-in into a retry.
      // The message has no provider error, body, URL, headers, or credentials.
      console.warn("[vitehub] AUTH_EVENT_WRITE_FAILED: Could not record an auth event.")
    }
  }
  async function deleted(session: { userId: string, id: string, impersonatedBy?: unknown }, ctx: GenericEndpointContext | null) {
    const type = ctx?.path === "/sign-out" ? "user.signed_out" : ctx?.path === "/admin/stop-impersonating" ? "impersonation.stopped" : "session.revoked"
    await append(type, session.userId, ctx, { sessionId: session.id }, identifier(session.impersonatedBy) ?? (type === "user.signed_out" ? session.userId : undefined))
  }
  return {
    id: "vitehub-auth-events",
    wrapStorage(storage) {
      return {
        get: key => storage.get(key),
        set: (key, value, ttl) => storage.set(key, value, ttl),
        getAndDelete: key => storage.getAndDelete(key),
        increment: (key, ttl) => storage.increment(key, ttl),
        async delete(key) {
          // Claim the actual removed value atomically, across requests and workers.
          const value = await storage.getAndDelete(key)
          if (!value) return
          let parsed: unknown
          try { parsed = typeof value === "string" ? JSON.parse(value) : value }
          catch { return }
          const session = record(record(parsed).session)
          const id = identifier(session.id)
          const userId = identifier(session.userId)
          if (id && userId && session.token === key) await deleted({ id, userId, impersonatedBy: session.impersonatedBy }, deletionContext.getStore() ?? null)
        },
      }
    },
    captureOutcome(ctx) {
      // Better Auth passes dispatch state to after-hooks outside the public middleware input type.
      const context = record(ctx).context
      if (context !== null && typeof context === "object") outcomes.set(context, record(context).returned)
    },
    init: () => ({ options: { databaseHooks: {
      user: {
        create: { async after(user, ctx) {
          await append("user.signed_up", user.id, ctx, { method: method(ctx) }, !ctx || ctx.path?.startsWith("/admin/") ? undefined : user.id)
        } },
        update: { async after(user, ctx) {
          const path = ctx?.path
          if (path === "/admin/ban-user") await append("user.banned", user.id, ctx)
          else if (path === "/admin/unban-user") await append("user.unbanned", user.id, ctx)
          else if (path === "/admin/set-role") await append("user.role_changed", user.id, ctx, { role: identifier(user.role) })
          else if (path === "/admin/update-user") {
            const data = record(record(ctx?.body).data)
            const fields = Object.keys(data).filter(key => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && Object.hasOwn(user, key)).slice(0, 100)
            await append("user.updated", user.id, ctx, { fields })
            if (Object.hasOwn(data, "role")) await append("user.role_changed", user.id, ctx, { role: identifier(user.role) })
            if (Object.hasOwn(data, "banned")) await append(user.banned ? "user.banned" : "user.unbanned", user.id, ctx)
          }
        } },
        delete: { async after(user, ctx) { await append("user.removed", user.id, ctx) } },
      },
      session: {
        create: { async after(session, ctx) {
          createdSessions.add(session)
          if (session.impersonatedBy || ctx?.path === "/admin/impersonate-user") {
            await append("impersonation.started", session.userId, ctx, { sessionId: session.id }, identifier(session.impersonatedBy))
          }
          else if (!ctx) {
            await append("user.signed_in", session.userId, ctx, { method: method(ctx), device: "unknown", sessionId: session.id })
          }
        } },
        delete: { async after(session, ctx) {
          await deleted(session, ctx)
        } },
      },
    } } }),
    hooks: {
      before: [{
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.path?.startsWith("/two-factor/verify-") && !await getSessionFromCtx(ctx, { disableRefresh: true })) {
            const cookie = ctx.context.createAuthCookie("two_factor")
            const token = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
            if (token && await ctx.context.internalAdapter.findVerificationValue(token)) challenges.add(ctx.context)
          }
          // Carry request attribution to the atomic secondary-storage deletion.
          if (!ctx.context.options.secondaryStorage || ctx.context.options.session?.storeSessionInDatabase) return
          const adapter = ctx.context.internalAdapter
          ctx.context.internalAdapter = {
            ...adapter,
            deleteSession: token => deletionContext.run(ctx, () => adapter.deleteSession(token)),
            deleteSessions: tokens => deletionContext.run(ctx, () => adapter.deleteSessions(tokens)),
            deleteUserSessions: userId => deletionContext.run(ctx, () => adapter.deleteUserSessions(userId)),
          }
        }),
      }, {
        matcher: ctx => Boolean(ctx.path?.startsWith("/oauth2/")),
        handler: createAuthMiddleware(async (ctx) => {
          // OAuth Provider writes its own models through the public adapter, outside core databaseHooks.
          // Wrap this request's adapter, so only a successful consent mutation records an event.
          const adapter = ctx.context.adapter
          if (wrappedAdapters.has(adapter)) return
          await getSessionFromCtx(ctx, { disableRefresh: true })
          async function consentEvent(type: "oauth.consent_granted" | "oauth.consent_revoked", value: unknown) {
            const consent = record(value)
            const userId = identifier(consent.userId)
            const clientId = identifier(consent.clientId)
            if (userId && clientId) await append(type, userId, ctx, { clientId })
          }
          ctx.context.adapter = {
            ...adapter,
            async create<T extends Record<string, unknown>, R = T>(input: Parameters<typeof adapter.create<T, R>>[0]) {
              const result = await adapter.create<T, R>(input)
              if (input.model === "oauthConsent") await consentEvent("oauth.consent_granted", result)
              return result
            },
            async update<T>(input: Parameters<typeof adapter.update<T>>[0]) {
              const result = await adapter.update<T>(input)
              if (input.model === "oauthConsent" && result) await consentEvent("oauth.consent_granted", result)
              return result
            },
            async delete(input) {
              const consent = input.model === "oauthConsent" ? await adapter.findOne(input) : undefined
              await adapter.delete(input)
              if (consent) await consentEvent("oauth.consent_revoked", consent)
            },
          }
          wrappedAdapters.add(ctx.context.adapter)
        }),
      }],
      after: [{
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const path = ctx.path ?? ""
          const outcome = outcomes.get(ctx.context)
          const value = record(outcome)
          const signedIn = ctx.context.newSession
          // Better Auth clears newSession when the first factor still needs 2FA.
          // This plugin runs after the app plugins, so only completed sign-ins count.
          if (signedIn && createdSessions.has(signedIn.session) && !signedIn.session.impersonatedBy && path !== "/admin/impersonate-user" && !recordedSessions.has(signedIn.session)) {
            recordedSessions.add(signedIn.session)
            await append("user.signed_in", signedIn.user.id, ctx, { method: method(ctx), device: authEventDevice(ctx.headers?.get("user-agent") ?? ctx.request?.headers.get("user-agent")), sessionId: signedIn.session.id }, signedIn.user.id)
          }
          if (!signedIn && outcome instanceof APIError && (path.startsWith("/sign-in/") || path === "/magic-link/verify" || path === "/passkey/verify-authentication" || challenges.has(ctx.context))) {
            await append("sign_in.failed", null, ctx, { method: method(ctx) })
          }
          if (outcome instanceof APIError) return
          if (path === "/admin/set-user-password") {
            const userId = identifier(record(ctx.body).userId)
            if (userId) { await getSessionFromCtx(ctx, { disableRefresh: true }); await append("user.updated", userId, ctx, { fields: ["password"] }) }
          }
          const operationId = record(ctx).operationId
          const type = path === "/organization/remove-member" || path === "/organization/leave" ? "organization.member_removed"
            : path === "/organization/update-member-role" ? "organization.member_role_changed"
              : path === "/organization/accept-invitation" || operationId === "addOrganizationMember" || path === "/organization/create" ? "organization.member_added" : undefined
          if (!type) return
          if (!ctx.context.session) await getSessionFromCtx(ctx, { disableRefresh: true })
          const members = path === "/organization/create" && Array.isArray(value.members) ? value.members : [value.member ?? value]
          for (const raw of members) {
            const member = record(raw)
            const userId = identifier(member.userId)
            const organizationId = identifier(member.organizationId)
            if (userId && organizationId) await append(type, userId, ctx, { organizationId, memberId: identifier(member.id), role: identifier(member.role) })
          }
        }),
      }],
    },
    endpoints: options.authorize ? {
      vitehubAuthEvents: createAuthEndpoint("/vitehub/events", { method: "GET", use: [sensitiveSessionMiddleware] }, async (ctx) => {
        if (!ctx.request) throw new APIError("FORBIDDEN")
        const authorization = await options.authorize!({ request: ctx.request, user: ctx.context.session.user, session: ctx.context.session.session })
        if (authorization instanceof Response) return authorization
        if (authorization !== true) throw new APIError("FORBIDDEN")
        ctx.setHeader("cache-control", "no-store")
        const query = new URL(ctx.request.url).searchParams
        let list: AuthEventListInput | undefined
        let window: { from: string, to: string } | undefined
        try {
          if (query.get("aggregate") === "true") window = parseAuthEventWindow({ from: query.get("from") ?? "", to: query.get("to") ?? "" })
          else {
            const input = Object.fromEntries([...query].filter(([key]) => key !== "limit"))
            list = parseAuthEventList({ ...input, ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}) }).query
          }
        }
        catch {
          throw new APIError("BAD_REQUEST", { message: "Invalid auth event filters." })
        }
        return ctx.json(window ? await options.store.aggregate(window) : await options.store.list(list))
      }),
    } : {},
  }
}
