import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

const createCodex = vi.hoisted(() => vi.fn(settings => ({ provider: "codex", settings })))

vi.mock("@ai-sdk/harness-codex", () => ({
  createCodex,
}))

describe("codexDriver", () => {
  it("defaults to direct OpenAI auth and contributes its Box requirement", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")

    const driver = codexDriver()

    expect(createCodex).toHaveBeenLastCalledWith({ auth: { openai: {} }, model: "" })
    expect(driver).toMatchObject({
      credentials: { label: "Codex", source: "ambient" },
      harness: { provider: "codex" },
      requires: ["codex"],
    })
    expect(driver.sandbox).toBeUndefined()
  })

  it("scrubs GitHub secrets when the default local sandbox is adapted", async () => {
    const originalGitHubToken = process.env.GITHUB_TOKEN
    const originalGitHubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY
    process.env.GITHUB_TOKEN = "github-token"
    process.env.GITHUB_APP_PRIVATE_KEY = "github-private-key"

    try {
      const { codexDriver } = await import("../src/harness/codex.ts")
      const { createLocalHarnessSandbox } = await import("../src/harness/local-sandbox.ts")
      const driver = codexDriver()
      const adaptSandbox = (driver.harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: object, options: { defaultSandbox: boolean }) => { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> }
      const session = await adaptSandbox(createLocalHarnessSandbox(), { defaultSandbox: true }).createSession()

      try {
        expect(session.env.GITHUB_TOKEN).toBeUndefined()
        expect(session.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined()
      }
      finally {
        await session.destroy()
      }
    }
    finally {
      restoreEnv("GITHUB_TOKEN", originalGitHubToken)
      restoreEnv("GITHUB_APP_PRIVATE_KEY", originalGitHubPrivateKey)
    }
  })

  it("preserves GitHub credentials in explicitly supplied sandboxes", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const { createLocalHarnessSandbox } = await import("../src/harness/local-sandbox.ts")
    const driver = codexDriver()
    const adaptSandbox = (driver.harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: object, options: { defaultSandbox: boolean }) => { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> }
    const provider = createLocalHarnessSandbox({ env: { GH_TOKEN: "box-token" } })
    const session = await adaptSandbox(provider, { defaultSandbox: false }).createSession()

    try {
      expect(session.env.GH_TOKEN).toBe("box-token")
    }
    finally {
      await session.destroy()
    }
  })

  it("keeps host AI Gateway env out of the default local Codex sandbox", async () => {
    const originalGatewayKey = process.env.AI_GATEWAY_API_KEY
    const originalGatewayBaseUrl = process.env.AI_GATEWAY_BASE_URL
    const originalGitHubToken = process.env.GITHUB_TOKEN
    const originalGitHubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY
    const originalGitHubWebhookSecret = process.env.VITEHUB_GITHUB_WEBHOOK_SECRET
    process.env.AI_GATEWAY_API_KEY = "host-key"
    process.env.AI_GATEWAY_BASE_URL = "https://gateway.example"
    process.env.GITHUB_TOKEN = "github-token"
    process.env.GITHUB_APP_PRIVATE_KEY = "github-private-key"
    process.env.VITEHUB_GITHUB_WEBHOOK_SECRET = "github-webhook-secret"

    try {
      const { codexDriver } = await import("../src/harness/codex.ts")
      const driver = codexDriver({ env: { EXTRA_CODEX_ENV: "1" } }) as { sandbox?: { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> } }
      const session = await driver.sandbox?.createSession()

      try {
        expect(session?.env.AI_GATEWAY_API_KEY).toBeUndefined()
        expect(session?.env.AI_GATEWAY_BASE_URL).toBeUndefined()
        expect(session?.env.GITHUB_TOKEN).toBeUndefined()
        expect(session?.env.GITHUB_APP_PRIVATE_KEY).toBeUndefined()
        expect(session?.env.VITEHUB_GITHUB_WEBHOOK_SECRET).toBeUndefined()
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
      restoreEnv("GITHUB_TOKEN", originalGitHubToken)
      restoreEnv("GITHUB_APP_PRIVATE_KEY", originalGitHubPrivateKey)
      restoreEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", originalGitHubWebhookSecret)
    }
  })

  it("uses ambient local Codex auth when explicit auth is omitted", async () => {
    const originalHome = process.env.HOME
    const home = await mkdtemp(join(tmpdir(), "vitehub-codex-home-"))
    await mkdir(join(home, ".codex"), { recursive: true })
    await writeFile(join(home, ".codex", "auth.json"), "{\"token\":\"local\"}\n")
    process.env.HOME = home

    try {
      const { codexDriver } = await import("../src/harness/codex.ts")
      const driver = codexDriver({ sandbox: {} }) as { sandbox?: { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> } }
      const session = await driver.sandbox?.createSession()

      try {
        expect(session?.env.CODEX_HOME).toContain("vitehub-codex-home-")
        await expect(readFile(join(session!.env.CODEX_HOME, "auth.json"), "utf8")).resolves.toBe("{\"token\":\"local\"}\n")
      }
      finally {
        await session?.destroy()
      }
    }
    finally {
      restoreEnv("HOME", originalHome)
      await rm(home, { force: true, recursive: true })
    }
  })

  it("creates isolated default local sandbox sessions", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const driver = codexDriver({ sandbox: {} }) as { sandbox?: { createSession: () => Promise<{ defaultWorkingDirectory: string, destroy: () => Promise<void> }> } }
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

    expect(createCodex).toHaveBeenLastCalledWith({ auth: { gateway: { apiKey: "gateway-key" } }, model: "" })
    expect(driver.sandbox).toBeUndefined()
    expect(driver.requires).toEqual(["codex-cli"])
  })

  it("does not adapt explicit local Codex sandboxes twice", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const driver = codexDriver({ sandbox: {} })
    const adaptSandbox = (driver.harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: object) => object

    expect(adaptSandbox(driver.sandbox! as object)).toBe(driver.sandbox)
  })

  it("forwards invocation-scoped harness configuration without treating it as Codex settings", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")
    const instructions = vi.fn(() => "Repair the pull request.")
    const workDir = vi.fn(() => "vitehub/pr-559")

    const driver = codexDriver<{ pullRequest: number }>({
      instructions,
      sandbox: false,
      workDir,
    })

    expect(driver.instructions).toBe(instructions)
    expect(driver.workDir).toBe(workDir)
    expect(createCodex).toHaveBeenLastCalledWith({ auth: { openai: {} }, model: "" })
  })

  it("preserves an empty work directory for harness validation", async () => {
    const { codexDriver } = await import("../src/harness/codex.ts")

    const driver = codexDriver({ sandbox: false, workDir: "" })

    expect(driver.workDir).toBe("")
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
