import { admin } from "better-auth/plugins"
import { H3, type Middleware } from "h3"
import type { UserConfig } from "vite"
import handleVirtualAuth, { withAuth as withVirtualAuth } from "#vitehub/auth/server"

import { describe, expectTypeOf, it } from "vitest"

import {
  authenticated,
  type AuthenticatedOptions,
  type AuthenticatedSessionData,
  type AuthenticatedUser,
} from "../src/agent.ts"
import {
  defineAuth,
  type AuthAuthorization,
  type AuthDefinition,
  type AuthDefinitionOptions,
  type AuthDefinitionResolver,
  type AuthFor,
  type AuthModuleOptions,
  type AuthRequest,
  type AuthReservedOption,
  type AuthResolvedDefinitionOptions,
  type AuthRuntimeContext,
  type AuthRuntimeEnv,
  type AuthRuntimeOptions,
  type AuthSessionRefresh,
  type RegisteredAuth,
  type ResolvedAuthDatabaseConfiguration,
  type ViteHubAuth,
} from "../src/index.ts"
import {
  auth,
  createAuthForRequest,
  getAuthForDefinition,
  getAuthorization,
  handleAuthRequest,
  requireAuth,
  requireAuthorization,
  withAuth,
  withAuthorization,
} from "../src/server.ts"
import * as authServer from "../src/server.ts"
import { stateless } from "../src/presets.ts"
import { hubAuth } from "../src/vite.ts"

import type { AgentInvokerOptions, AgentRuntimeConfig } from "@vite-hub/agent"

describe("types", () => {
  it("exposes the intended Auth Definition surface", () => {
    const definition = defineAuth({
      access: {
        routes: [{
          authorize: ({ request, session, user }) => {
            expectTypeOf(request.url).toEqualTypeOf<string>()
            expectTypeOf(session).toEqualTypeOf<Record<string, unknown>>()
            expectTypeOf(user.id).toEqualTypeOf<string>()
            return user.isAdmin === true
          },
          route: "/_vitehub/**",
        }],
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

  it("preserves the inferred Auth Definition type for each input form", () => {
    const options = { appName: "ViteHub", plugins: [admin()] }
    expectTypeOf(defineAuth(options)).toEqualTypeOf<AuthDefinition<AuthDefinitionOptions<typeof options>>>()

    const resolver = ({ requestOrigin }: AuthRuntimeContext) => ({ ...options, baseURL: requestOrigin })
    expectTypeOf(defineAuth(resolver)).toEqualTypeOf<AuthDefinition<AuthDefinitionResolver<ReturnType<typeof resolver>>>>()
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
    expectTypeOf(withAuth(() => "ok")(h3LikeRequest)).toEqualTypeOf<Promise<string | Response>>()
    expectTypeOf(handleVirtualAuth(h3LikeRequest)).toEqualTypeOf<Promise<Response>>()
    expectTypeOf(withVirtualAuth(() => "ok")(h3LikeRequest)).toEqualTypeOf<Promise<string | Response>>()
  })

  it("runs protected handlers only with the result of an Auth guard", () => {
    const event = { req: new Request("https://app.example.com/photos/user-1/meal.jpg") }
    const guarded = withAuthorization(true, (input: typeof event, authorization) => {
      expectTypeOf(input).toEqualTypeOf<typeof event>()
      expectTypeOf(authorization).toEqualTypeOf<AuthAuthorization>()
      expectTypeOf(authorization.user.id).toEqualTypeOf<string>()
      return "photo"
    })
    expectTypeOf(guarded).toEqualTypeOf<(input: typeof event) => Promise<string | Response>>()
    withAuth((_input: typeof event, { session }) => session)

    // @ts-expect-error The old guard returned `Response | undefined` and let the protected action run after a missed check.
    void authServer.authorizeRequest
    // @ts-expect-error A guard needs the protected handler.
    withAuthorization(true)
    // @ts-expect-error `authorize` is `true` or a callback. `false` does not mean "public".
    withAuthorization(false, () => "photo")
    // @ts-expect-error Callers cannot pass their own authorization to a guarded handler.
    void guarded(event, { request: event.req, session: {}, user: { id: "admin" } })
    // @ts-expect-error The guard can return a rejection `Response`, so callers must handle it.
    const body: Promise<string> = guarded(event)
    void body
    // @ts-expect-error The checked authorization is read-only.
    withAuth((_input: typeof event, authorization) => { authorization.user = { id: "admin" } })
  })

  it("types Auth route middleware for H3 2", () => {
    const signedIn = requireAuth()
    const owner = requireAuthorization(({ request, user }) => new URL(request.url).pathname.startsWith(`/posts/${user.id}`))
    expectTypeOf(signedIn).toMatchTypeOf<Middleware>()
    expectTypeOf(owner).toMatchTypeOf<Middleware>()
    expectTypeOf(requireAuthorization(true)).toMatchTypeOf<Middleware>()

    new H3()
      .get("/me", (event) => {
        const authorization = getAuthorization(event)
        expectTypeOf(authorization).toEqualTypeOf<AuthAuthorization>()
        // @ts-expect-error The checked authorization is read-only.
        authorization.user = { id: "admin" }
        return { id: authorization.user.id }
      }, { middleware: [signedIn] })
      .delete("/posts/:id", event => getAuthorization(event).user.id, { middleware: [owner] })

    // @ts-expect-error The middleware is the result of `requireAuth()`, not the function itself.
    void new H3().get("/me", () => "ok", { middleware: [requireAuth] })
    // @ts-expect-error `requireAuth()` returns middleware. It does not check an event.
    void requireAuth({ req: new Request("https://app.example.com/me") })
    // @ts-expect-error `authorize` is `true` or a callback. `false` does not mean "public".
    void requireAuthorization(false)
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
    expectTypeOf<"access" | "basePath" | "database" | "preset" | "route" | "runtime" | "secondaryStorage">().toMatchTypeOf<AuthReservedOption>()
  })

  it("types the Better Auth instance with the plugins of its Auth Definition", () => {
    const definition = defineAuth({ appName: "ViteHub", plugins: [admin()] })
    expectTypeOf(getAuthForDefinition(definition)).toEqualTypeOf<AuthFor<typeof definition>>()
    expectTypeOf(getAuthForDefinition(definition).api.listUsers).toBeFunction()
    expectTypeOf<ViteHubAuth["api"]>().not.toHaveProperty("listUsers")

    const resolved = defineAuth(() => ({ appName: "ViteHub", plugins: [admin()] }))
    expectTypeOf(getAuthForDefinition(resolved).api.banUser).toBeFunction()
  })

  it("types the app's Auth instance from the generated Auth registry", () => {
    const definition = defineAuth({ appName: "ViteHub", plugins: [admin()] })
    expectTypeOf<RegisteredAuth<{ definition: typeof definition }>>().toEqualTypeOf<AuthFor<typeof definition>>()
    expectTypeOf<RegisteredAuth<{ definition: typeof definition }>["api"]["listUsers"]>().toBeFunction()
    expectTypeOf<RegisteredAuth<{}>>().toEqualTypeOf<ViteHubAuth>()
    expectTypeOf(authServer.getAuthForRequest).returns.toEqualTypeOf<RegisteredAuth>()
    expectTypeOf(authServer.getAuth).returns.toEqualTypeOf<RegisteredAuth>()
    expectTypeOf(authServer.assertAuthOrigin).returns.toEqualTypeOf<Promise<RegisteredAuth>>()
  })

  it("types session.onRefresh in static and callback definitions", () => {
    const definition = defineAuth({
      plugins: [admin()],
      session: {
        updateAge: 60,
        onRefresh({ session, user, refresh, clear }) {
          expectTypeOf(session.token).toEqualTypeOf<string>()
          expectTypeOf(user.email).toEqualTypeOf<string>()
          expectTypeOf(refresh).toBeCallableWith()
          expectTypeOf(refresh).toBeCallableWith({ plan: "pro" })
          expectTypeOf(clear).toBeCallableWith()
        },
      },
    })
    expectTypeOf<AuthFor<typeof definition>["api"]["listUsers"]>().toBeFunction()

    const onRefresh: AuthSessionRefresh = ({ refresh }) => refresh()
    defineAuth(() => ({ session: { onRefresh } }))

    // @ts-expect-error onRefresh is a function.
    defineAuth({ session: { onRefresh: true } })
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

  it("accepts presets from @vite-hub/auth/presets", () => {
    defineAuth({ preset: stateless({ maxAge: "7d" }) })
    defineAuth(({ requestOrigin }) => ({ baseURL: requestOrigin, preset: stateless({ maxAge: 3600 }) }))

    // @ts-expect-error a preset comes from a preset function.
    defineAuth({ preset: { name: "custom" } })

    // @ts-expect-error maxAge is seconds or a duration with a unit.
    stateless({ maxAge: "7 days" })
  })
});

describe("Auth Console declarations", () => {
  it("types computed users and additional field policy", () => {
    defineAuth({
      user: { additionalFields: { plan: { type: ["free", "pro"] } } },
      console: {
        fields: { plan: { editable: true } },
        columns: {
          projects: {
            type: "number",
            label: "Projects",
            read: (users) => Object.fromEntries(users.map((user) => [user.id, 2])),
          },
        },
      },
    });
    // @ts-expect-error A numeric column cannot return strings.
    defineAuth({ user: { additionalFields: { plan: { type: "string" } } }, console: { columns: { count: { type: "number", label: "Count", read: () => ({ user: "two" }) } } } });
  });
});

it("keeps the Console operation error union", async () => {
  const inspect = {} as import("../src/console-runtime.ts").AuthConsole;
  const [error, users] = await inspect.users();
  if (error)
    expectTypeOf(error.code).toEqualTypeOf<
      | "AUTH_CONSOLE_INVALID_REQUEST"
      | "AUTH_CONSOLE_FORBIDDEN"
      | "AUTH_CONSOLE_NOT_FOUND"
      | "AUTH_CONSOLE_UNAVAILABLE"
      | "AUTH_CONSOLE_PROVIDER_FAILED"
    >();
  else
    expectTypeOf(users.items).toEqualTypeOf<import("../src/console-types.ts").AuthConsoleUser[]>();
});
