import { afterEach, describe, expect, it, vi } from "vitest"

const { resolveVercelBox } = vi.hoisted(() => ({
  resolveVercelBox: vi.fn(async () => ({ open: vi.fn(), plan: {} })),
}))

vi.mock("@vite-hub/box/_internal/vercel", () => ({ resolveVercelBox }))

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

    const provider = await resolveSandboxBox({
      local: {},
      provider: {
        provider: "vercel",
        token: "token-from-config",
      },
    })
    expect(provider).toMatchObject({ provider: "vercel" })
    await provider.resolveBox(["node"])
    expect(resolveVercelBox).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token-from-config",
        teamId: "team-from-env",
        projectId: "project-from-env",
      }),
      ["node"],
    )
  })

  it("uses config credentials without process", async () => {
    vi.stubGlobal("process", undefined)

    const provider = await resolveSandboxBox({
      local: {},
      provider: {
        provider: "vercel",
        token: "token-from-config",
        teamId: "team-from-config",
        projectId: "project-from-config",
      },
    })
    expect(provider).toMatchObject({ provider: "vercel" })
    await provider.resolveBox(["node"])
    expect(resolveVercelBox).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token-from-config",
        teamId: "team-from-config",
        projectId: "project-from-config",
      }),
      ["node"],
    )
  })
})
