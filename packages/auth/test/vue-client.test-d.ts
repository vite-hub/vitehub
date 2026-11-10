import { inferAdditionalFields } from "better-auth/client/plugins"
import { admin, bearer, organization } from "better-auth/plugins"
import { describe, expectTypeOf, it } from "vitest"

import { defineAuth } from "../src/index.ts"
import { authClient, createAuthClient, loadAuthClient, useAuthClient, useUserSession, type RegisteredAuthClient } from "../src/vue.ts"

describe("Vue Auth client types", () => {
  it("gives the client the user and session fields that the Auth Definition adds", () => {
    const definition = defineAuth({
      plugins: [admin()],
      session: { additionalFields: { tenantId: { type: "string", required: true } } },
      user: { additionalFields: { plan: { type: ["free", "pro"], required: true } } },
    })
    type Client = RegisteredAuthClient<{ definition: typeof definition }>
    type Session = Client["$Infer"]["Session"]

    expectTypeOf<Session["user"]["plan"]>().toEqualTypeOf<"free" | "pro">()
    // `admin()` adds `role` to the user and `impersonatedBy` to the session.
    expectTypeOf<Session["user"]["role"]>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<Session["session"]["tenantId"]>().toEqualTypeOf<string>()
    expectTypeOf<Session["session"]["impersonatedBy"]>().toEqualTypeOf<string | null | undefined>()

    const { user, session } = useUserSession({} as Client)
    expectTypeOf(user.value!.plan).toEqualTypeOf<"free" | "pro">()
    expectTypeOf(session.value!.tenantId).toEqualTypeOf<string>()
  })

  it("reads the fields from a Definition callback", () => {
    const definition = defineAuth(({ requestOrigin }) => ({
      baseURL: requestOrigin,
      plugins: [admin()],
      user: { additionalFields: { plan: { type: "string", required: false } } },
    }))
    type User = RegisteredAuthClient<{ definition: typeof definition }>["$Infer"]["Session"]["user"]
    expectTypeOf<User["plan"]>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<User["role"]>().toEqualTypeOf<string | null | undefined>()
  })

  it("keeps the fields when a server plugin has no schema", () => {
    // `bearer()` has no `schema`. It must not turn `user` and `session` into `never`.
    const definition = defineAuth({
      plugins: [bearer(), organization()],
      user: { additionalFields: { plan: { type: "string", required: true } } },
    })
    type Session = RegisteredAuthClient<{ definition: typeof definition }>["$Infer"]["Session"]
    expectTypeOf<Session["user"]["plan"]>().toEqualTypeOf<string>()
    expectTypeOf<Session["session"]["activeOrganizationId"]>().toEqualTypeOf<string | null | undefined>()
  })

  it("keeps the plain Better Auth fields when the Definition type is any", () => {
    // `.vitehub/types/auth.d.ts` gives `any` when the app's tsconfig cannot resolve `server/auth.ts`. `JSON.parse()` returns `any` too.
    type UnresolvedDefinition = ReturnType<typeof JSON.parse>
    expectTypeOf<RegisteredAuthClient<{ definition: UnresolvedDefinition }>>().toEqualTypeOf<RegisteredAuthClient<{}>>()
  })

  it("accepts a custom client with required additional fields", () => {
    const client = createAuthClient({ plugins: [inferAdditionalFields({ user: { plan: { type: "string", required: true } } })] })
    expectTypeOf(useUserSession(client).user.value!.plan).toEqualTypeOf<string>()
    expectTypeOf(loadAuthClient(client)).resolves.toEqualTypeOf(client)
  })

  it("types the default client from the generated Auth registry", () => {
    expectTypeOf(authClient).toEqualTypeOf<RegisteredAuthClient>()
    expectTypeOf(useAuthClient()).toEqualTypeOf<RegisteredAuthClient>()
    expectTypeOf(useUserSession().user.value).toEqualTypeOf<RegisteredAuthClient["$Infer"]["Session"]["user"] | null>()
  })

  it("keeps the plain Better Auth fields without a discovered Auth Definition", () => {
    type Session = RegisteredAuthClient<{}>["$Infer"]["Session"]
    expectTypeOf<keyof Session["user"]>().toEqualTypeOf<"id" | "createdAt" | "updatedAt" | "email" | "emailVerified" | "name" | "image">()
  })
})
