import { expectTypeOf, it } from "vitest"

import { checkGitHubOrgMember } from "../src/index.ts"

it("returns the codes that a membership check can fail with", async () => {
  const [error, data] = await checkGitHubOrgMember("token", "acme")
  if (error) {
    expectTypeOf(error.code).toEqualTypeOf<"AUTH_GITHUB_NOT_ORG_MEMBER" | "AUTH_GITHUB_ORG_ACCESS_DENIED" | "AUTH_GITHUB_TOKEN_INVALID" | "AUTH_GITHUB_UNAVAILABLE">()
    expectTypeOf(data).toEqualTypeOf<undefined>()
  }
})
