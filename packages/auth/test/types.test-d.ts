import type { UserConfig } from "vite"
import handleVirtualAuth, { requireAuth as requireVirtualAuth } from "#vitehub/auth/server"

import { describe, expectTypeOf, it } from "vitest"

import {
  authenticated,
  type AuthenticatedOptions,
  type AuthenticatedSessionData,
  type AuthenticatedUser,
} from "../src/agent.ts"
import {
  defineAuth,
  type AuthDefinition,
  type AuthDefinitionResolver,
  type AuthModuleOptions,
  type AuthRequest,
  type AuthReservedOption,
  type AuthResolvedDefinitionOptions,
  type AuthRuntimeContext,
  type AuthRuntimeEnv,
  type AuthRuntimeOptions,
  type ResolvedAuthDatabaseConfiguration,
} from "../src/index.ts"
import {
  auth,
  createAuthForRequest,
  handleAuthRequest,
  requireAuth,
} from "../src/server.ts"
import { hubAuth } from "../src/vite.ts"

import type { AgentInvokerOptions, AgentRuntimeConfig } from "@vite-hub/agent"

describe("types", () => {
  it("exposes the intended Auth Definition surface", () => {
    const definition = defineAuth({
      access: {
        signIn: {
          callbackURL: "/app",
          provider: "github",
          scopes: ["read:org"],
        },
      },
      appName: "ViteHub",
      database: { name: "auth" },
      runtime: ({ env, request, requestOrigin }) => {
        expectTypeOf(request?.url).toMatchTypeOf<string | undefined>()
        return {
          baseURL: requestOrigin,
          secret: typeof env.value === "string" ? env.value : "runtime-secret",
        }
      },
      secondaryStorage: true,
    })

    expectTypeOf(definition).toMatchTypeOf<AuthDefinition>()
    expectTypeOf(definition.options.database).toMatchTypeOf<{ name: string } | true | undefined>()
    expectTypeOf(definition.options.runtime).toMatchTypeOf<AuthRuntimeOptions | ((context: AuthRuntimeContext) => AuthRuntimeOptions) | undefined>()
    expectTypeOf<AuthRuntimeEnv>().toMatchTypeOf<Record<string, unknown>>()
  })

  it("exposes request-scoped Auth Definition callbacks", () => {
    const definition = defineAuth(({ env, request, requestOrigin }) => {
      expectTypeOf(request?.headers).toMatchTypeOf<Headers | undefined>()
      return {
        appName: "ViteHub",
        baseURL: requestOrigin,
        secret: typeof env.value === "string" ? env.value : "runtime-secret",
      }
    })

    expectTypeOf(definition).toMatchTypeOf<AuthDefinition<AuthDefinitionResolver>>()
    expectTypeOf(definition.options).toMatchTypeOf<AuthDefinitionResolver<AuthResolvedDefinitionOptions>>()
  })

  it("augments vite user config with auth options", () => {
    const config: UserConfig = {
      auth: {},
    }

    expectTypeOf(config.auth).toMatchTypeOf<AuthModuleOptions | undefined>()
    expectTypeOf(hubAuth()).toHaveProperty("api")
  })

  it("exposes the server auth handler shape", () => {
    expectTypeOf(auth.handler).parameters.toEqualTypeOf<[Request]>()
    expectTypeOf(auth.handler).returns.toEqualTypeOf<Promise<Response>>()

    const runtimeAuth = createAuthForRequest(defineAuth({ appName: "ViteHub" }), new Request("https://app.example.com/api/auth"), {
      socialProviders: {
        github: {
          clientId: "client-id",
          clientSecret: "client-secret",
        },
      },
      trustedOrigins: ["https://app.example.com"],
    })
    expectTypeOf(runtimeAuth.handler).parameters.toEqualTypeOf<[Request]>()

    const request = new Request("https://app.example.com/api/auth")
    const h3LikeRequest = {
      body: request.body,
      headers: request.headers,
      method: request.method,
      signal: request.signal,
      url: request.url,
    } satisfies AuthRequest

    expectTypeOf(handleAuthRequest(defineAuth({ appName: "ViteHub" }), h3LikeRequest)).toEqualTypeOf<Promise<Response>>()
    expectTypeOf(requireAuth(h3LikeRequest)).toEqualTypeOf<Promise<Response | undefined>>()
    expectTypeOf(handleVirtualAuth(h3LikeRequest)).toEqualTypeOf<Promise<Response>>()
    expectTypeOf(requireVirtualAuth(h3LikeRequest)).toEqualTypeOf<Promise<Response | undefined>>()
  })

  it("exposes the authenticated Agent Invoker helper", () => {
    const invoker = authenticated({
      id: ({ user }) => user.email,
      meta: ({ session }) => ({ authSessionId: session.id }),
      source: () => ({
        session: { id: "session_1" },
        user: { email: "maxi@example.com", id: "user_1" },
      }),
    })

    const typedInvoker = authenticated<
      AgentRuntimeConfig,
      unknown,
      AuthenticatedUser & { email: string },
      AuthenticatedSessionData & { id: string }
    >({
      id: ({ user }) => user.email,
      source: () => ({
        session: { id: "session_1" },
        user: { email: "maxi@example.com", id: "user_1" },
      }),
    })

    expectTypeOf(invoker).toMatchTypeOf<AgentInvokerOptions>()
    expectTypeOf(typedInvoker).toMatchTypeOf<AgentInvokerOptions>()
    expectTypeOf({ kind: "authUser" }).toMatchTypeOf<AuthenticatedOptions>()

  })

  it("exposes resolved database placement metadata", () => {
    const defaultPlacement = { mode: "default" } satisfies ResolvedAuthDatabaseConfiguration
    const namedPlacement = { dedicated: true, mode: "named", name: "auth" } satisfies ResolvedAuthDatabaseConfiguration

    expectTypeOf(defaultPlacement).toMatchTypeOf<ResolvedAuthDatabaseConfiguration>()
    expectTypeOf(namedPlacement).toMatchTypeOf<ResolvedAuthDatabaseConfiguration>()
  })

  it("marks every ViteHub-owned Auth Definition field as reserved", () => {
    expectTypeOf<"access" | "basePath" | "database" | "route" | "runtime" | "secondaryStorage">().toMatchTypeOf<AuthReservedOption>()
  })

  it("rejects runtime-only and raw storage options in definitions", () => {
    // @ts-expect-error baseURL is runtime config, not Auth Definition config.
    defineAuth({ baseURL: "https://example.com" })

    // @ts-expect-error secret is runtime config, not Auth Definition config.
    defineAuth({ secret: "secret" })

    // @ts-expect-error object-shaped database config requires a name.
    defineAuth({ database: { dedicated: true } })

    // @ts-expect-error raw Better Auth database adapters do not belong in the Auth Definition.
    defineAuth({ database: { db: {} } })

    // @ts-expect-error object-shaped secondary storage config requires a store.
    defineAuth({ secondaryStorage: {} })

    // @ts-expect-error route only supports false when provided.
    defineAuth({ route: true })
  })
})
