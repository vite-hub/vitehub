import { env } from "@vite-hub/env"
import { createRuntimeEnvRegistry } from "@vite-hub/env/vite"
import { describe, expect, it } from "vitest"

import { emailDeploymentEnv } from "../src/deployment-env.ts"

describe("emailDeploymentEnv", () => {
  it("names the provider variables of server/email.ts and skips literal options", () => {
    const registry = createRuntimeEnvRegistry({
      apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
      from: "team@example.com",
    }, { path: "email.options" })
    const entries = emailDeploymentEnv(registry)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ required: true, secret: true, hasDefault: false, owners: ["email"] })
    expect(entries[0]!.names).toContain("RESEND_API_KEY")
    expect(JSON.stringify(entries)).not.toContain("team@example.com")
  })

  it("names nothing without a definition", () => {
    expect(emailDeploymentEnv(undefined)).toEqual([])
  })
})
