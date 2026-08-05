import { describe, expect, it, vi } from "vitest"

const createCodex = vi.hoisted(() => vi.fn(settings => ({ provider: "codex", settings })))

vi.mock("@ai-sdk/harness-codex", () => ({
  createCodex,
}))

describe("createCodexDriver", () => {
  it("keeps capacity on the ViteHub driver boundary", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const capacity = { concurrency: 2, queue: { maxPending: 20, timeout: 300_000 } }

    const driver = createCodexDriver({ capacity })

    expect(driver.capacity).toEqual(capacity)
    expect(createCodex).toHaveBeenLastCalledWith({ auth: { openai: {} }, model: "" })
  })

  it("defaults to direct OpenAI auth and contributes its Box requirement", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")

    const driver = createCodexDriver()

    expect(createCodex).toHaveBeenLastCalledWith({ auth: { openai: {} }, model: "" })
    expect(driver).toMatchObject({
      credentials: { label: "Codex", source: "ambient" },
      harness: { provider: "codex" },
      requires: [{ name: "Codex", command: "codex", args: ["login", "status"] }],
    })
    expect(driver.sandbox).toBeUndefined()
  })

  it("scrubs GitHub secrets when the default local sandbox is adapted", async () => {
    const originalGitHubToken = process.env.GITHUB_TOKEN
    const originalGitHubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY
    process.env.GITHUB_TOKEN = "github-token"
    process.env.GITHUB_APP_PRIVATE_KEY = "github-private-key"

    try {
      const { createCodexDriver } = await import("../src/harness/codex.ts")
      const { createLocalHarnessSandbox } = await import("../src/harness/local-sandbox.ts")
      const driver = createCodexDriver()
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
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const { createLocalHarnessSandbox } = await import("../src/harness/local-sandbox.ts")
    const driver = createCodexDriver()
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
      const { createCodexDriver } = await import("../src/harness/codex.ts")
      const driver = createCodexDriver({ env: { EXTRA_CODEX_ENV: "1" } }) as { sandbox?: { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> } }
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

  it("creates isolated default local sandbox sessions", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const driver = createCodexDriver({ sandbox: {} }) as { sandbox?: { createSession: () => Promise<{ defaultWorkingDirectory: string, destroy: () => Promise<void> }> } }
    const first = await driver.sandbox?.createSession()
    const second = await driver.sandbox?.createSession()

    try {
      expect(first?.defaultWorkingDirectory).toMatch(/[\\/]vitehub-harness[\\/]owner-\d+-[0-9a-f-]{36}[\\/]session-/)
      expect(second?.defaultWorkingDirectory).toMatch(/[\\/]vitehub-harness[\\/]owner-\d+-[0-9a-f-]{36}[\\/]session-/)
      expect(first?.defaultWorkingDirectory).not.toBe(second?.defaultWorkingDirectory)
    }
    finally {
      await first?.destroy()
      await second?.destroy()
    }
  })

  it("passes through explicit harness sandbox providers", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const provider = {
      providerId: "isolated",
      specificationVersion: "harness-sandbox-v1",
      createSession: vi.fn(),
    }

    const driver = createCodexDriver({ sandbox: provider })

    expect(driver.sandbox).toBe(provider)
  })

  it("passes through harness sandbox provider resolvers", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const provider = {
      providerId: "isolated",
      specificationVersion: "harness-sandbox-v1",
      createSession: vi.fn(),
    }
    const resolver = vi.fn(() => provider)

    const driver = createCodexDriver({ sandbox: resolver })

    expect(driver.sandbox).toBe(resolver)
  })

  it("preserves explicit Codex auth settings", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")

    const driver = createCodexDriver({ auth: { gateway: { apiKey: "gateway-key" } }, sandbox: false })

    expect(createCodex).toHaveBeenLastCalledWith({ auth: { gateway: { apiKey: "gateway-key" } }, model: "" })
    expect(driver.sandbox).toBeUndefined()
    expect(driver.requires).toEqual(["codex"])
  })

  it("does not adapt explicit local Codex sandboxes twice", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const driver = createCodexDriver({ sandbox: {} })
    const adaptSandbox = (driver.harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: object) => object

    expect(adaptSandbox(driver.sandbox! as object)).toBe(driver.sandbox)
  })

  it("adapts resumed Codex sandbox sessions", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const run = vi.fn()
    const rawSession = {
      defaultWorkingDirectory: "/sandbox/run-1",
      env: { GITHUB_TOKEN: "secret" },
      restricted: () => ({ run }),
      run,
    }
    const provider = {
      createSession: vi.fn(async () => rawSession),
      resumeSession: vi.fn(async () => rawSession),
      specificationVersion: "harness-sandbox-v1",
    }
    const adapt = (createCodexDriver({ sandbox: false }).harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessSandboxAdapter")] as (provider: object, options: { defaultSandbox: boolean }) => typeof provider & { resumeSession(options: { sessionId: string }): Promise<typeof rawSession> }
    const resumed = await adapt(provider, { defaultSandbox: true }).resumeSession({ sessionId: "thread-1" })

    await resumed.run({ command: "node /tmp/harness/codex/bridge.mjs" })

    expect(resumed.env).not.toHaveProperty("GITHUB_TOKEN")
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: "node /sandbox/run-1/tmp/harness/codex/bridge.mjs",
      env: { CODEX_HOME: "/sandbox/run-1/tmp/harness/codex-home" },
    }))
  })

  it("preserves optional resume support and stock Codex auth homes", async () => {
    const { adaptCodexHarnessSandbox } = await import("../src/internal/codex-sandbox.ts")
    const run = vi.fn()
    const rawSession = {
      defaultWorkingDirectory: "/sandbox/run-1",
      env: {},
      restricted: () => ({ run }),
      run,
    }
    const provider = {
      createSession: vi.fn(async () => rawSession),
      specificationVersion: "harness-sandbox-v1",
    }
    const adapted = adaptCodexHarnessSandbox(provider, { isolateHome: false })! as typeof provider & { resumeSession?: unknown }
    const session = await adapted.createSession()

    await session.run({ command: "node /tmp/harness/codex/bridge.mjs" })

    expect(adapted).not.toHaveProperty("resumeSession")
    expect(run).toHaveBeenCalledWith({ command: "node /sandbox/run-1/tmp/harness/codex/bridge.mjs" })
  })

  it("exposes an isolated global skill directory", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const driver = createCodexDriver({ sandbox: false })
    const directory = (driver.harness as Record<PropertyKey, unknown>)[
      Symbol.for("vitehub.harnessGlobalSkillsDirectory")
    ] as (context: { box?: unknown }, invocation?: { id: string, isolateBoxHome: boolean }) => string

    expect(directory({})).toBe("tmp/harness/codex-home/skills")
    expect(directory({ box: {} })).toBe(".codex/skills")
    expect(directory({ box: {} }, { id: "invocation-1", isolateBoxHome: true }))
      .toBe(".vitehub/codex-home-invocation-1/skills")
  })

  it("uses Box-owned Codex Home without replacing its authentication state", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const run = vi.fn(async (_options: { command: string, env?: Record<string, string | undefined> }) => ({ exitCode: 0, stderr: "" }))
    const restrictedRun = vi.fn(async (_options: { command: string, env?: Record<string, string | undefined> }) => ({ exitCode: 0, stderr: "" }))
    const rawSession = {
      defaultWorkingDirectory: "/sandbox/run-1",
      env: { CODEX_HOME: "/box/.codex", HOME: "/box" },
      restricted: () => ({ run: restrictedRun, spawn: vi.fn() }),
      run,
      spawn: vi.fn(),
    }
    const provider = {
      specificationVersion: "harness-sandbox-v1",
      async createSession(options: { onFirstCreate?: (session: object, context: object) => Promise<void> }) {
        await options.onFirstCreate?.(rawSession, {})
        return rawSession
      },
    }
    const driver = createCodexDriver({ sandbox: provider })
    const adaptSandbox = (driver.harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessInvocationSandboxAdapter")] as (provider: object, options: { box: boolean, defaultSandbox: boolean, invocation: { id: string, isolateBoxHome: boolean } }) => { createSession: () => Promise<typeof rawSession> }
    const invocation = { id: "invocation-1", isolateBoxHome: true }
    const session = await adaptSandbox(provider, { box: true, defaultSandbox: false, invocation }).createSession()

    const prepareSession = (driver.harness as Record<PropertyKey, unknown>)[Symbol.for("vitehub.harnessSessionPrepare")] as (session: object, invocation?: { id: string, isolateBoxHome: boolean }) => Promise<{ close: () => Promise<void> } | undefined>
    const prepared = await prepareSession(session, invocation)

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining('export VITEHUB_AMBIENT_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export CODEX_HOME="$HOME/.vitehub/codex-home-invocation-1";'),
    }))
    expect(run.mock.calls[0][0].command).toContain('ambient_home="${VITEHUB_AMBIENT_CODEX_HOME:-$HOME/.codex}"')
    expect(run.mock.calls[0][0].command).toContain('cp -R "$ambient_home"/. "$codex_home"')
    expect(run.mock.calls[0][0].command).toContain('rm -rf -- "$codex_home/skills/$managed"')
    expect(run.mock.calls[0][0].command).toContain('manifest="$codex_home/skills/.vitehub-colocated"')
    expect(run.mock.calls[0][0].command).toContain('baseline="$codex_home.vitehub-baseline"')
    await session.run({ command: "codex exec" })
    expect(run).toHaveBeenLastCalledWith({
      command: 'export VITEHUB_AMBIENT_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export CODEX_HOME="$HOME/.vitehub/codex-home-invocation-1"; codex exec',
    })
    await session.restricted().run({ command: "codex exec" })
    expect(restrictedRun).toHaveBeenCalledWith({
      command: 'export VITEHUB_AMBIENT_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"; export CODEX_HOME="$HOME/.vitehub/codex-home-invocation-1"; codex exec',
    })
    await prepared?.close()
    expect(run).toHaveBeenLastCalledWith({
      command: expect.stringMatching(/rm -rf -- "\$codex_home\/skills\/\$managed".*find "\$baseline" -type f.*cmp -s.*cp -R "\$codex_home"\/\. "\$ambient_home".*if \[ "\$status" -eq 0 \]; then rm -rf/),
    })
    expect(run.mock.calls.at(-1)?.[0].command).toContain('"$codex_home/skills/.vitehub-colocated"')
    expect(run.mock.calls.at(-1)?.[0].command).toContain('cmp -s "$seeded" "$ambient_home/$relative"')
  })

  it("forwards invocation-scoped harness configuration without treating it as Codex settings", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")
    const instructions = vi.fn(() => "Repair the pull request.")
    const workDir = vi.fn(() => "vitehub/pr-559")

    const driver = createCodexDriver<{ pullRequest: number }>({
      instructions,
      sandbox: false,
      workDir,
    })

    expect(driver.instructions).toBe(instructions)
    expect(driver.workDir).toBe(workDir)
    expect(createCodex).toHaveBeenLastCalledWith({ auth: { openai: {} }, model: "" })
  })

  it("preserves an empty work directory for harness validation", async () => {
    const { createCodexDriver } = await import("../src/harness/codex.ts")

    const driver = createCodexDriver({ sandbox: false, workDir: "" })

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
