import { afterEach, describe, expect, it, vi } from "vitest"

const { vercelBox } = vi.hoisted(() => ({ vercelBox: vi.fn(() => ({ name: "vercel" })) }))

vi.mock("@vite-hub/box/vercel", () => ({ vercelBox }))

import { resolveSandboxBox } from "../src/runtime/providers/vercel.ts"

const envKeys = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of envKeys) {
    delete process.env[key]
  }
})

describe("resolveSandboxBox", () => {
  it("merges Vercel credentials from provider options and env", async () => {
    process.env.VERCEL_TEAM_ID = "team-from-env"
    process.env.VERCEL_PROJECT_ID = "project-from-env"

    await expect(resolveSandboxBox({
      local: {},
      provider: {
        provider: "vercel",
        token: "token-from-config",
      },
    })).resolves.toMatchObject({ provider: "vercel", runtime: { name: "vercel" } })
    expect(vercelBox).toHaveBeenCalledWith(expect.objectContaining({
        token: "token-from-config",
        teamId: "team-from-env",
        projectId: "project-from-env",
    }))
  })

  it("uses config credentials without process", async () => {
    vi.stubGlobal("process", undefined)

    await expect(resolveSandboxBox({
      local: {},
      provider: {
        provider: "vercel",
        token: "token-from-config",
        teamId: "team-from-config",
        projectId: "project-from-config",
      },
    })).resolves.toMatchObject({ provider: "vercel", runtime: { name: "vercel" } })
    expect(vercelBox).toHaveBeenCalledWith(expect.objectContaining({
        token: "token-from-config",
        teamId: "team-from-config",
        projectId: "project-from-config",
    }))
  })
})
