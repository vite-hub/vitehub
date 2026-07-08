import { describe, expect, it, vi } from "vitest"

const createCodex = vi.hoisted(() => vi.fn(settings => ({ provider: "codex", settings })))

vi.mock("@ai-sdk/harness-codex", () => ({
  createCodex,
}))

describe("codexDriver", () => {
  it("defaults to direct OpenAI auth and local sandbox credentials", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")

    const driver = codexDriver()

    expect(createCodex).toHaveBeenLastCalledWith({ auth: { openai: {} } })
    expect(driver).toMatchObject({
      credentials: { label: "Codex", source: "ambient" },
      harness: { provider: "codex" },
      sandbox: { providerId: "local" },
    })
  })

  it("keeps host AI Gateway env out of the default local Codex sandbox", async () => {
    const originalGatewayKey = process.env.AI_GATEWAY_API_KEY
    const originalGatewayBaseUrl = process.env.AI_GATEWAY_BASE_URL
    process.env.AI_GATEWAY_API_KEY = "host-key"
    process.env.AI_GATEWAY_BASE_URL = "https://gateway.example"

    try {
      const { codexDriver } = await import("../src/harness/codex.ts")
      const driver = codexDriver({ env: { EXTRA_CODEX_ENV: "1" } }) as { sandbox?: { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> } }
      const session = await driver.sandbox?.createSession()

      try {
        expect(session?.env.AI_GATEWAY_API_KEY).toBeUndefined()
        expect(session?.env.AI_GATEWAY_BASE_URL).toBeUndefined()
        expect(session?.env.EXTRA_CODEX_ENV).toBe("1")
        expect(session?.env.PATH).toContain("node_modules/.bin")
      }
      finally {
        await session?.destroy()
      }
    }
    finally {
      restoreEnv("AI_GATEWAY_API_KEY", originalGatewayKey)
      restoreEnv("AI_GATEWAY_BASE_URL", originalGatewayBaseUrl)
    }
  })

  it("creates isolated default local sandbox sessions", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const driver = codexDriver() as { sandbox?: { createSession: () => Promise<{ defaultWorkingDirectory: string, destroy: () => Promise<void> }> } }
    const first = await driver.sandbox?.createSession()
    const second = await driver.sandbox?.createSession()

    try {
      expect(first?.defaultWorkingDirectory).toContain("vitehub-harness-")
      expect(second?.defaultWorkingDirectory).toContain("vitehub-harness-")
      expect(first?.defaultWorkingDirectory).not.toBe(second?.defaultWorkingDirectory)
    }
    finally {
      await first?.destroy()
      await second?.destroy()
    }
  })

  it("passes through explicit harness sandbox providers", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const provider = {
      providerId: "isolated",
      specificationVersion: "harness-sandbox-v1",
      createSession: vi.fn(),
    }

    const driver = codexDriver({ sandbox: provider })

    expect(driver.sandbox).toBe(provider)
  })

  it("passes through harness sandbox provider resolvers", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const provider = {
      providerId: "isolated",
      specificationVersion: "harness-sandbox-v1",
      createSession: vi.fn(),
    }
    const resolver = vi.fn(() => provider)

    const driver = codexDriver({ sandbox: resolver })

    expect(driver.sandbox).toBe(resolver)
  })

  it("preserves explicit Codex auth settings", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")

    const driver = codexDriver({ auth: { gateway: { apiKey: "gateway-key" } }, sandbox: false })

    expect(createCodex).toHaveBeenLastCalledWith({ auth: { gateway: { apiKey: "gateway-key" } } })
    expect(driver.sandbox).toBeUndefined()
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
