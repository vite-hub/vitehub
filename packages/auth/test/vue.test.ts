import { describe, expect, it } from "vitest"

import { authClient, createAuthClient, useAuthClient, useSession, useSignIn, useSignUp, useUserSession } from "../src/vue.ts"

describe("Vue Auth composables", () => {
  it("projects the shared Better Auth Vue client", () => {
    expect(useAuthClient() === authClient).toBe(true)
    expect(useSession()).toBeDefined()
    expect(typeof useSignIn()).toBe("function")
    expect(typeof useSignUp()).toBe("function")
  })

  it("keeps Better Auth client configuration available", () => {
    const client = createAuthClient({ basePath: "/auth" })
    const session = useUserSession(client)

    expect(client.useSession).toBeTypeOf("function")
    expect(session.loggedIn.value).toBe(false)
  })
})
