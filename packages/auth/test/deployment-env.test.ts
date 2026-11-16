import { describe, expect, it } from "vitest"

import { adminClaimVariable } from "../src/admin-claim-code.ts"
import { adminsVariable } from "../src/admins.ts"
import { authDeploymentEnv } from "../src/deployment-env.ts"

import type { ResolvedAuthViteConfig } from "../src/types.ts"

describe("authDeploymentEnv", () => {
  it("names the Better Auth secrets, then VITEHUB_SECRET, and the optional admin variables", () => {
    // SAFETY: authDeploymentEnv reads only whether Auth is configured.
    const entries = authDeploymentEnv({} as ResolvedAuthViteConfig)
    expect(entries).toEqual([
      { names: ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "AUTH_SECRET", "VITEHUB_SECRET"], required: true, secret: true, hasDefault: false, owners: ["auth"] },
      { names: [adminsVariable], required: false, secret: false, hasDefault: false, owners: ["auth"] },
      { names: [adminClaimVariable], required: false, secret: true, hasDefault: false, owners: ["auth"] },
    ])
  })

  it("names nothing when the app has no Auth Definition", () => {
    expect(authDeploymentEnv(undefined)).toEqual([])
  })
})
