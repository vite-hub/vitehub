import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveSandboxProvider } from "../src/runtime/providers/vercel.ts"

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

describe("resolveSandboxProvider", () => {
  it("merges Vercel credentials from provider options and env", async () => {
    process.env.VERCEL_TEAM_ID = "team-from-env"
    process.env.VERCEL_PROJECT_ID = "project-from-env"

    await expect(resolveSandboxProvider({
      local: {},
      provider: {
        provider: "vercel",
        token: "token-from-config",
      },
    })).resolves.toMatchObject({
      credentials: {
        token: "token-from-config",
        teamId: "team-from-env",
        projectId: "project-from-env",
      },
    })
  })

  it("uses config credentials without process", async () => {
    vi.stubGlobal("process", undefined)

    await expect(resolveSandboxProvider({
      local: {},
      provider: {
        provider: "vercel",
        token: "token-from-config",
        teamId: "team-from-config",
        projectId: "project-from-config",
      },
    })).resolves.toMatchObject({
      credentials: {
        token: "token-from-config",
        teamId: "team-from-config",
        projectId: "project-from-config",
      },
    })
  })
})

describe("Vercel lifecycle errors", () => {
  afterEach(() => {
    vi.doUnmock("@vercel/sandbox")
    vi.resetModules()
  })

  it.each([
    ["create", async (provider: typeof import("../src/sandbox/providers/vercel.ts")) => provider.createVercelSandboxClient({ provider: "vercel" })],
    ["list", async (provider: typeof import("../src/sandbox/providers/vercel.ts")) => provider.VercelSandboxStatic.list()],
    ["get", async (provider: typeof import("../src/sandbox/providers/vercel.ts")) => provider.VercelSandboxStatic.get("sandbox-id")],
  ] as const)("normalizes %s SDK rejections", async (operation, invoke) => {
    const cause = new Error(`Vercel ${operation} failed with token=secret`)
    vi.doMock("@vercel/sandbox", () => ({
      Sandbox: {
        create: vi.fn(async () => { throw cause }),
        get: vi.fn(async () => { throw cause }),
        list: vi.fn(async () => { throw cause }),
      },
    }))

    const provider = await import("../src/sandbox/providers/vercel.ts")
    const { SandboxError } = await import("../src/sandbox/errors.ts")
    const error = await invoke(provider).catch(error => error)

    expect(error).toBeInstanceOf(SandboxError)
    expect(error).toMatchObject({
      cause,
      code: "SANDBOX_RUNTIME_ERROR",
      details: { operation, provider: "vercel" },
      message: "Sandbox execution failed.",
    })
    expect(JSON.stringify(error)).not.toContain(cause.message)
  })

  it("does not normalize local Vercel instance shape errors", async () => {
    vi.doMock("@vercel/sandbox", () => ({
      Sandbox: {
        create: vi.fn(async () => ({})),
      },
    }))

    const { createVercelSandboxClient } = await import("../src/sandbox/providers/vercel.ts")
    const { SandboxError } = await import("../src/sandbox/errors.ts")
    const error = await createVercelSandboxClient({ provider: "vercel" }).catch(error => error)

    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(SandboxError)
  })
})
