import type { UserConfig } from "vite"

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
  type AuthModuleOptions,
  type AuthReservedOption,
  type ResolvedAuthDatabaseConfiguration,
} from "../src/index.ts"
import { auth, createAuthForRequest } from "../src/server.ts"
import { hubAuth } from "../src/vite.ts"

import type { AgentInvokerOptions, AgentRuntimeConfig } from "@vite-hub/agent"

describe("types", () => {
  it("exposes the intended Auth Definition surface", () => {
    const definition = defineAuth({
      appName: "ViteHub",
      database: { name: "auth" },
      secondaryStorage: true,
    })

    expectTypeOf(definition).toMatchTypeOf<AuthDefinition>()
    expectTypeOf(definition.options.database).toMatchTypeOf<{ name: string } | true | undefined>()
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
    expectTypeOf<"basePath" | "database" | "route" | "secondaryStorage">().toMatchTypeOf<AuthReservedOption>()
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
