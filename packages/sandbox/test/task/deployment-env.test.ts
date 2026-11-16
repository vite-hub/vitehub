import { describe, expect, it } from "vitest"

import { sandboxDeploymentEnv } from "../../src/task/deployment-env.ts"

const owners = ["sandbox"]

describe("sandboxDeploymentEnv", () => {
  it("requires the Vercel Sandbox credentials outside Vercel", () => {
    expect(sandboxDeploymentEnv({ provider: "vercel" }, "vercel", { host: "node" })).toEqual([
      { names: ["VITE_SANDBOX_TOKEN", "VERCEL_TOKEN"], required: true, secret: true, hasDefault: false, owners },
      { names: ["VITE_SANDBOX_TEAM_ID", "VERCEL_TEAM_ID"], required: true, secret: false, hasDefault: false, owners },
      { names: ["VITE_SANDBOX_PROJECT_ID", "VERCEL_PROJECT_ID"], required: true, secret: false, hasDefault: false, owners },
    ])
  })

  it("keeps them optional on Vercel, where the deployment's OIDC token signs in", () => {
    expect(sandboxDeploymentEnv({ provider: "vercel" }, "vercel", { host: "vercel" }).map(entry => entry.required)).toEqual([false, false, false])
  })

  it("skips a credential that the config sets, and never writes it", () => {
    const canary = "canary-token-4b2a"
    const entries = sandboxDeploymentEnv({ provider: "vercel", token: canary, teamId: "team_1" }, "vercel", { host: "node" })
    expect(entries.map(entry => entry.names[0])).toEqual(["VITE_SANDBOX_PROJECT_ID"])
    expect(JSON.stringify(entries)).not.toContain(canary)
  })

  it("names nothing for a Cloudflare Sandbox or when Sandbox is off", () => {
    expect(sandboxDeploymentEnv({ provider: "cloudflare" }, "cloudflare", { host: "cloudflare" })).toEqual([])
    expect(sandboxDeploymentEnv(false, undefined, { host: "node" })).toEqual([])
  })
})
