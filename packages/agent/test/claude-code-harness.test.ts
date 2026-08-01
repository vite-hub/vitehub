import { describe, expect, it, vi } from "vitest"

import type { HarnessV1, HarnessV1PromptTurnOptions, HarnessV1StreamPart } from "@ai-sdk/harness"

const createAiSdkClaudeCode = vi.hoisted(() =>
  vi.fn(settings => ({
    settings,
    async getBootstrap() {
      return {
        harnessId: "claude-code",
        bootstrapDir: "/tmp/claude-code",
        files: [
          { path: "/tmp/claude-code/package.json", content: "{}" },
          {
            path: "/tmp/claude-code/bridge.mjs",
            content: `if (type === "auth_status" && typeof msg.error === "string" && msg.error.trim()) {
        emitTerminalError(msg.error);
        continue;
      }
      if (type === "system" && msg.subtype === "api_retry") {
        continue;
      }`,
          },
        ],
        commands: [],
      }
    },
    async doStart() {
      return {
        sessionId: "test-session",
        isResume: false,
        async doPromptTurn(options: HarnessV1PromptTurnOptions) {
          options.emit({ type: "stream-start" })
          options.emit({
            type: "finish",
            finishReason: "stop",
            totalUsage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          } as unknown as HarnessV1StreamPart)
          return { done: Promise.resolve() }
        },
      }
    },
  })),
)

vi.mock("@ai-sdk/harness-claude-code", () => ({
  createClaudeCode: createAiSdkClaudeCode,
}))

describe("createClaudeCodeDriver", () => {
  it("keeps capacity on the ViteHub driver boundary", async () => {
    const { createClaudeCodeDriver } = await import("../src/harness/claude-code.ts")
    const capacity = { concurrency: 2, queue: { maxPending: 20, timeout: 300_000 } }

    const driver = await createClaudeCodeDriver({ capacity, sandbox: false })

    expect(driver.capacity).toEqual(capacity)
    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({ auth: { anthropic: {} } })
  })

  it("defaults to ambient Claude Code auth and local sandbox credentials", async () => {
    const { createClaudeCodeDriver } = await import("../src/harness/claude-code.ts")

    const driver = await createClaudeCodeDriver()

    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({ auth: { anthropic: {} } })
    expect(driver).toMatchObject({
      credentials: { label: "Claude Code", source: "ambient" },
      harness: { settings: { auth: { anthropic: {} } } },
      sandbox: { providerId: "local" },
    })
  })

  it("keeps host Anthropic env out of the default local Claude Code sandbox", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = "host-key"
    process.env.ANTHROPIC_AUTH_TOKEN = "host-token"
    process.env.ANTHROPIC_BASE_URL = "https://host.example"

    try {
      const { createClaudeCodeDriver } = await import("../src/harness/claude-code.ts")
      const driver = await createClaudeCodeDriver({ env: { EXTRA_CLAUDE_ENV: "1" } }) as { sandbox?: { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> } }
      const session = await driver.sandbox?.createSession()

      try {
        expect(session?.env.ANTHROPIC_API_KEY).toBeUndefined()
        expect(session?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
        expect(session?.env.ANTHROPIC_BASE_URL).toBeUndefined()
        expect(session?.env.EXTRA_CLAUDE_ENV).toBe("1")
        expect(session?.env.PATH).toContain("node_modules/.bin")
      }
      finally {
        await session?.destroy()
      }
    }
    finally {
      restoreEnv("ANTHROPIC_API_KEY", originalApiKey)
      restoreEnv("ANTHROPIC_AUTH_TOKEN", originalAuthToken)
      restoreEnv("ANTHROPIC_BASE_URL", originalBaseUrl)
    }
  })

  it("preserves explicit Claude Code auth settings and sandbox env", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "host-key"

    try {
      const { createClaudeCodeDriver } = await import("../src/harness/claude-code.ts")
      const driver = await createClaudeCodeDriver({
        auth: { anthropic: { apiKey: "explicit-auth-key" } },
        maxTurns: 3,
        model: "claude-sonnet-4-5",
        sandbox: {
          env: { ANTHROPIC_API_KEY: "explicit-sandbox-key" },
        },
      }) as { sandbox?: { createSession: () => Promise<{ destroy: () => Promise<void>, env: Record<string, string> }> } }
      const session = await driver.sandbox?.createSession()

      try {
        expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({
          auth: { anthropic: { apiKey: "explicit-auth-key" } },
          maxTurns: 3,
          model: "claude-sonnet-4-5",
        })
        expect(session?.env.ANTHROPIC_API_KEY).toBe("explicit-sandbox-key")
      }
      finally {
        await session?.destroy()
      }
    }
    finally {
      restoreEnv("ANTHROPIC_API_KEY", originalApiKey)
    }
  })

  it("can defer the local Claude Code sandbox to the Agent Driver fallback", async () => {
    const { createClaudeCodeDriver } = await import("../src/harness/claude-code.ts")

    const driver = await createClaudeCodeDriver({ sandbox: false })

    expect(driver).not.toHaveProperty("sandbox")
  })
})

describe("createClaudeCode", () => {
  it("defaults to direct Anthropic auth so host AI Gateway env does not leak into Claude Code", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")

    await createClaudeCode()

    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({ auth: { anthropic: {} } })
  })

  it("preserves explicit Claude Code auth settings", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")

    await createClaudeCode({ auth: { gateway: { apiKey: "gateway-key" } }, maxTurns: 3 })

    expect(createAiSdkClaudeCode).toHaveBeenLastCalledWith({
      auth: { gateway: { apiKey: "gateway-key" } },
      maxTurns: 3,
    })
  })

  it("publishes assistant error handling through the Claude Code bootstrap bridge", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")
    const harness = await createClaudeCode() as HarnessV1 & { getBootstrap: NonNullable<HarnessV1["getBootstrap"]> }
    const bootstrap = await harness.getBootstrap()
    const bridge = bootstrap.files.find(file => file.path.endsWith("/bridge.mjs"))?.content

    expect(bridge).toContain(`type === "assistant" && typeof msg.error === "string" && msg.error.trim()`)
    expect(bridge).toContain(`emitTerminalError(stringifyContent(msg.content) || msg.error)`)
  })

  it("surfaces empty zero-token Claude Code turns as harness errors", async () => {
    const { createClaudeCode } = await import("../src/harness/claude-code.ts")
    const events: HarnessV1StreamPart[] = []
    const session = await (await createClaudeCode() as HarnessV1).doStart({} as Parameters<HarnessV1["doStart"]>[0])

    await session.doPromptTurn({
      prompt: "hello",
      emit: event => events.push(event),
    })

    expect(events.map(event => event.type)).toEqual(["stream-start", "error"])
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: expect.objectContaining({
        message: expect.stringContaining("Claude Code returned no output"),
      }),
    })
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}
