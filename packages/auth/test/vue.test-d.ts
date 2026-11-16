import { describe, expectTypeOf, it } from "vitest"

import { authClient, useUserSession, type SignOutOptions } from "../src/vue.ts"

describe("signOut() of useUserSession()", () => {
  it("takes Better Auth's options and redirectTo, and returns Better Auth's result", () => {
    const { signOut } = useUserSession()

    expectTypeOf(signOut).toBeCallableWith()
    expectTypeOf(signOut).toBeCallableWith({ redirectTo: "/goodbye", fetchOptions: { headers: { "x-reason": "menu" } } })
    expectTypeOf(signOut).toBeCallableWith({ callbackURL: "/goodbye" })
    expectTypeOf(signOut).toBeCallableWith(undefined, { onSuccess: () => {} })
    expectTypeOf<SignOutOptions>().toHaveProperty("redirectTo").toEqualTypeOf<string | undefined>()
    expectTypeOf(signOut).returns.toEqualTypeOf<ReturnType<typeof authClient.signOut>>()
    // @ts-expect-error `redirectTo` is a path or a URL.
    void signOut({ redirectTo: 1 })
  })
})
