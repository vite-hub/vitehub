import { adminClient, organizationClient } from "better-auth/client/plugins"
import { describe, expectTypeOf, it } from "vitest"

import { authClient, defineAuthClient, useAuthClient, useUserSession, type RegisteredAuthClient, type VueAuthClient } from "../src/vue.ts"

describe("Auth client options types", () => {
  it("gives the default client the endpoints of the client plugins in auth.client.ts", () => {
    const options = defineAuthClient({ plugins: [adminClient(), organizationClient()] })
    // `.vitehub/types/auth.d.ts` registers `client: typeof import("../../app/auth.client.js").default`.
    type Client = RegisteredAuthClient<{ client: typeof options }>

    expectTypeOf<Client>().toEqualTypeOf<VueAuthClient<typeof options>>()
    expectTypeOf<Client["admin"]["listUsers"]>().toBeFunction()
    expectTypeOf<Client["organization"]["create"]>().toBeFunction()
    // `admin()` on the server adds `role` to the user, and `adminClient()` tells the client.
    expectTypeOf<Client["$Infer"]["Session"]["user"]["role"]>().toEqualTypeOf<string | null | undefined>()

    const { client } = useUserSession({} as Client)
    expectTypeOf(client).toEqualTypeOf<Client>()
    expectTypeOf(client.admin.listUsers).toBeFunction()
  })

  it("keeps the plain client without auth.client.ts, or when its type is any", () => {
    expectTypeOf<RegisteredAuthClient<{}>>().toEqualTypeOf<VueAuthClient<{}>>()
    expectTypeOf<RegisteredAuthClient<{ client: ReturnType<typeof JSON.parse> }>>().toEqualTypeOf<VueAuthClient<{}>>()
    expectTypeOf<RegisteredAuthClient<{}>>().not.toHaveProperty("admin")
  })

  it("types the default client and the session's client from the generated registry", () => {
    expectTypeOf(authClient).toEqualTypeOf<RegisteredAuthClient>()
    expectTypeOf(useAuthClient()).toEqualTypeOf<RegisteredAuthClient>()
    expectTypeOf(useUserSession().client).toEqualTypeOf<RegisteredAuthClient>()
  })

  it("rejects options that Better Auth's client does not take", () => {
    // @ts-expect-error `plugins` is a list of client plugins.
    defineAuthClient({ plugins: "admin" })
  })
})
