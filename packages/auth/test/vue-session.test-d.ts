import { describe, expectTypeOf, it } from "vitest"

import { createAuthClient, useUserSession } from "../src/vue.ts"

describe("useUserSession()", () => {
  it("returns the session of the client from refresh()", () => {
    const client = createAuthClient({ basePath: "/auth" })

    expectTypeOf(useUserSession(client).refresh).returns.resolves.toEqualTypeOf<typeof client.$Infer.Session | null>()
  })
})
