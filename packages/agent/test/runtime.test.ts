import { afterEach, describe, expect, it, vi } from "vitest"

import { createMessage, getMessageText } from "@vite-hub/agent"
import { chat, chatTitle, schedule } from "../src/capabilities.ts"

const harnessAgentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const harnessCreateSession = vi.hoisted(() => vi.fn())
const harnessGenerate = vi.hoisted(() => vi.fn())
const harnessStream = vi.hoisted(() => vi.fn())

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(settings: Record<string, unknown>) {
      harnessAgentSettings.push(settings)
    }

    async createSession(...args: unknown[]) {
      return await harnessCreateSession.apply(this, args)
    }

    async generate(...args: unknown[]) {
      return await harnessGenerate.apply(this, args)
    }

    async stream(...args: unknown[]) {
      return await harnessStream.apply(this, args)
    }
  },
}))

afterEach(() => {
  harnessAgentSettings.length = 0
  harnessCreateSession.mockReset()
  harnessGenerate.mockReset()
  harnessStream.mockReset()
})

describe("agent message protocol", () => {
  it("runs custom Agent Drivers through the invocation lifecycle", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const run = vi.fn(context => `received ${context.prompt}`)
    const agent = defineAgent({
      driver: { run },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toBe("received hello")
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
    }))
  })

  it("runs harness Agent Drivers through AI SDK HarnessAgent", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    harnessAgentSettings.length = 0
    const session = { destroy: vi.fn() }
    const harness = { provider: "codex" }
    const sandbox = { provider: "sandbox" }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness,
        sandbox,
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      harness,
      permissionMode: "allow-all",
      sandbox,
    })
    expect(harnessCreateSession).toHaveBeenCalledWith(undefined)
    expect(harnessGenerate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      session,
    }))
    expect(session.destroy).toHaveBeenCalledTimes(1)
  })

  it("labels non-token harness usage with sanitized credentials", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({
      text: "ok",
      usage: {
        actions: 3,
        wallTimeMs: 1200,
      },
    })

    const agent = defineAgent({
      capabilities: [usageTelemetry()],
      driver: {
        credentials: { label: "local Codex", source: "ambient" },
        harness: { provider: "codex" },
        sandbox: { provider: "sandbox" },
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        credentialSource: {
          label: "local Codex",
          source: "ambient",
        },
        usage: {
          details: {
            actions: 3,
            wallTimeMs: 1200,
          },
        },
      },
    })
  })

  it("resumes harness Agent Drivers with an explicit session key", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const firstSession = { detach: vi.fn(async () => ({ token: "resume" })), destroy: vi.fn() }
    const secondSession = { detach: vi.fn(async () => ({ token: "next" })), destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession)
    harnessGenerate.mockResolvedValue({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
        sandbox: { provider: "sandbox" },
        sessionKey: "thread-1",
      },
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })
    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "again" })

    expect(harnessCreateSession).toHaveBeenNthCalledWith(1, { sessionId: "thread-1" })
    expect(harnessCreateSession).toHaveBeenNthCalledWith(2, { resumeFrom: { token: "resume" }, sessionId: "thread-1" })
    expect(firstSession.detach).toHaveBeenCalledTimes(1)
    expect(secondSession.detach).toHaveBeenCalledTimes(1)
  })

  it("rejects mixed, permission-shaped, or raw-credential Agent Drivers", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => defineAgent({
      driver: { model: {} as never, run: () => "ok" },
    } as never)).toThrow("requires exactly one")

    expect(() => defineAgent({
      driver: { harness: { provider: "codex" }, permissions: "bypass" },
    } as never)).toThrow("does not expose harness permission options")

    expect(() => defineAgent({
      driver: { credentials: { value: "secret" }, harness: { provider: "codex" } },
    } as never)).toThrow("driver.credentials.value")

    expect(() => defineAgent({
      driver: { harness: { provider: "codex" }, instructions: "ignored" },
    } as never)).toThrow("does not support option: instructions")

    expect(() => defineAgent({
      driver: { model: {} as never, sandbox: { provider: "sandbox" } },
    } as never)).toThrow("does not support option: sandbox")

    expect(() => defineAgent({
      driver: { execution: {}, run: () => "ok" },
    } as never)).toThrow("does not support option: execution")
  })

  it("creates inline schedule capabilities without requiring chat history", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      capabilities: [schedule({ schedules: ["0   9 * * *", { cron: "15 10 * * 1-5", id: "weekday-digest" }] })],
      run: () => "ok",
    })

    expect(agent.capabilities).toEqual([
      expect.objectContaining({
        id: "schedule",
        metadata: {
          kind: "schedule",
          schedules: [
            { cron: "0 9 * * *", id: "schedule-0-9" },
            { cron: "15 10 * * 1-5", id: "weekday-digest" },
          ],
        },
      }),
    ])
    expect(agent.chat).toBeUndefined()
  })

  it("runs scheduled agents with schedule-owned input metadata and no synthetic messages", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const seen: unknown[] = []
    const agent = defineAgent({
      run: context => {
        seen.push({ input: context.input, messages: context.messages })
        return "ok"
      },
    })

    await expect(runScheduledAgent(agent, {
      attemptId: "attempt-1",
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      runId: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
      target: "support",
    })).resolves.toBe("ok")

    expect(seen).toEqual([{
      input: {
        context: {
          schedule: {
            id: "srun_schedule_2026-05-23T09:00:00.000Z",
            kind: "schedule",
            runId: "srun_schedule_2026-05-23T09:00:00.000Z",
            scheduleId: "schedule-0-9",
            scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
            target: "support",
          },
        },
      },
      messages: [],
    }])
  })

  it("uses the schedule id as run id when scheduled context omits provider run id", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const seen: unknown[] = []
    const agent = defineAgent({
      run: context => {
        seen.push(context.input)
        return "ok"
      },
    })

    await expect(runScheduledAgent(agent, {
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
    })).resolves.toBe("ok")

    expect(seen).toEqual([{
      context: {
        schedule: expect.objectContaining({
          id: "srun_schedule_2026-05-23T09:00:00.000Z",
          runId: "srun_schedule_2026-05-23T09:00:00.000Z",
        }),
      },
    }])
  })

  it("memoizes scheduled agent runtime values by key", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const create = vi.fn(() => ({ ok: true }))
    const agent = defineAgent({
      run: context => [
        context.memo("resource", create),
        context.memo("resource", create),
      ],
    })

    const result = await runScheduledAgent(agent, {
      attemptId: "attempt-1",
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      runId: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
      target: "support",
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(result).toEqual([{ ok: true }, { ok: true }])
    expect((result as unknown[])[0]).toBe((result as unknown[])[1])
  })

  it("runs scheduled agents with host runtime context", async () => {
    const { defineAgent, runScheduledAgent } = await import("../src/index.ts")
    const waitUntil = vi.fn()
    const seen: unknown[] = []
    const agent = defineAgent({
      run: context => {
        seen.push({
          run: context.run,
          runtime: context.runtime,
          waitUntil: context.waitUntil,
        })
        return "ok"
      },
    })

    await expect(runScheduledAgent(agent, {
      attemptId: "attempt-1",
      id: "srun_schedule_2026-05-23T09:00:00.000Z",
      runId: "srun_schedule_2026-05-23T09:00:00.000Z",
      scheduleId: "schedule-0-9",
      scheduledAt: new Date("2026-05-23T09:00:00.000Z"),
      target: "support",
    }, {
      run: { origin: "cloudflare", runId: "host-run" },
      runtime: "vite",
      runtimeConfig: { region: "iad" },
      waitUntil,
    })).resolves.toBe("ok")

    expect(seen).toEqual([{
      run: { origin: "cloudflare", runId: "srun_schedule_2026-05-23T09:00:00.000Z" },
      runtime: "vite",
      waitUntil,
    }])
  })

  it("converts ViteHub messages to model messages internally", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    expect(toAiSdkModelMessages([
      createMessage({ id: "m1", role: "user", text: "hello" }),
    ])).toEqual([
      { content: "hello", role: "user" },
    ])
  })

  it("drops empty ViteHub messages before model conversion", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    expect(toAiSdkModelMessages([
      createMessage({ id: "m1", role: "user", text: "" }),
      createMessage({ id: "m2", parts: [], role: "assistant" }),
      createMessage({ id: "m3", parts: [], role: "tool" }),
      createMessage({ id: "m4", role: "user", text: "hello" }),
    ])).toEqual([
      { content: "hello", role: "user" },
    ])
  })

  it("preserves structured tool history for model messages", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    expect(toAiSdkModelMessages([
      createMessage({
        id: "m1",
        parts: [
          { id: "call-1", input: { query: "ok" }, name: "lookup", state: "running", type: "tool-call" },
          { id: "call-1", name: "lookup", output: { ok: true }, state: "completed", type: "tool-result" },
        ],
        role: "tool",
      }),
    ])).toEqual([
      {
        content: [{ output: { type: "json", value: { ok: true } }, toolCallId: "call-1", toolName: "lookup", type: "tool-result" }],
        role: "tool",
      },
    ])
  })

  it("splits assistant tool result history into valid model messages", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    expect(toAiSdkModelMessages([
      createMessage({
        id: "m1",
        parts: [
          { id: "call-1", input: { query: "ok" }, name: "lookup", state: "running", type: "tool-call" },
          { id: "call-1", name: "lookup", output: { ok: true }, state: "completed", type: "tool-result" },
          { text: "done", type: "text" },
        ],
        role: "assistant",
      }),
    ])).toEqual([
      {
        content: [{ input: { query: "ok" }, toolCallId: "call-1", toolName: "lookup", type: "tool-call" }],
        role: "assistant",
      },
      {
        content: [{ output: { type: "json", value: { ok: true } }, toolCallId: "call-1", toolName: "lookup", type: "tool-result" }],
        role: "tool",
      },
      {
        content: [{ text: "done", type: "text" }],
        role: "assistant",
      },
    ])
  })

  it("normalizes generated output into an agent run result", async () => {
    const { runAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "ok", usage: { inputTokens: 1 } })),
      stream: vi.fn(),
      tools: {},
      version: "agent-v1",
    }

    await expect(runAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toMatchObject({
      finishReason: "stop",
      text: "ok",
      usage: { inputTokens: 1 },
    })
    expect(agent.generate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ content: "hello", role: "user" }],
    }))
  })

  it("resolves capability-owned triggers and runs them through the agent lifecycle", async () => {
    const { defineAgent, resolveAgentTriggers, runAgentTrigger } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [{
        id: "custom",
        triggers: {
          ping: {
            async invoke(_context, input: { prompt: string }) {
              return {
                input: { prompt: input.prompt },
                metadata: { source: "test" },
                run: { runId: "trigger-run" },
              }
            },
          },
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      run: context => `received ${context.prompt}`,
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(resolveAgentTriggers(agent, runtime)).resolves.toMatchObject({
      "custom.ping": {
        capabilityId: "custom",
        id: "custom.ping",
        name: "ping",
      },
    })
    await expect(runAgentTrigger(agent, runtime, "custom.ping", { prompt: "hello" })).resolves.toBe("received hello")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        run: { runId: "trigger-run" },
      }),
    }))
  })

  it("creates custom trigger capabilities with entry()", async () => {
    const { defineAgent, runAgentTrigger } = await import("../src/index.ts")
    const { entry } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [entry({
        id: "portal",
        triggers: {
          message: {
            invoke: (_context, input: { text: string }) => ({
              input: { messages: [createMessage({ role: "user", text: input.text })] },
              run: { origin: "portal", runId: "portal-run" },
            }),
          },
        },
      })],
      run: context => `received ${getMessageText(context.messages[0]!)}`,
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(runAgentTrigger(agent, runtime, "portal.message", { text: "hello" })).resolves.toBe("received hello")
  })

  it("exposes chat webhook registration metadata through agent triggers", async () => {
    const { chat } = await import("../src/chat-trigger.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = {
      capabilities: [
        chat({
          concurrency: "queue",
          webhooks: {
            telegram: {
              path: "/api/webhooks/telegram",
              secretToken: "secret-token",
            },
            slack: {
              path: "/api/webhooks/slack",
              secretHeader: "x-slack-signature",
            },
          },
        }),
      ],
      resolve: vi.fn(),
    }

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: [{
          id: "telegram",
          method: "POST",
          path: "/api/webhooks/telegram",
          provider: "telegram",
          secretHeader: "x-telegram-bot-api-secret-token",
          secretToken: "secret-token",
        }, {
          id: "slack",
          method: "POST",
          path: "/api/webhooks/slack",
          provider: "slack",
          secretHeader: "x-slack-signature",
        }],
      },
    })
  })

  it("infers webhook registration metadata from static chat adapters", async () => {
    const { chat } = await import("../src/chat-trigger.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = {
      capabilities: [
        chat({
          platforms: {
            teams: () => ({}) as never,
            telegram: () => ({}) as never,
          },
        }),
      ],
      resolve: vi.fn(),
    }

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: [{
          id: "teams",
          method: "POST",
          provider: "teams",
        }, {
          id: "telegram",
          method: "POST",
          provider: "telegram",
          secretHeader: "x-telegram-bot-api-secret-token",
        }],
      },
    })
  })

  it("creates chat triggers from message-shaped channels", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { teams } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const adapter = () => ({}) as never
    const agent = defineAgent({
      channels: {
        support: teams({
          adapter,
          webhooks: {
            path: "/api/teams/support",
          },
        }),
      },
      messages: {
        concurrency: "queue",
        history: { maxMessages: 20, source: "thread" },
        sessions: true,
      },
      run: () => "ok",
    })

    expect(agent.chat).toMatchObject({
      concurrency: "queue",
      history: { maxMessages: 20, source: "thread" },
      sessions: true,
      webhooks: {
        support: {
          id: "support",
          path: "/api/teams/support",
          provider: "teams",
        },
      },
    })
    expect(agent.chat?.platforms).toEqual({ support: adapter })
    expect(agent.capabilities?.some(capability => capability.id === "chat")).toBe(true)
    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: [{
          id: "support",
          method: "POST",
          path: "/api/teams/support",
          provider: "teams",
        }],
      },
    })
  })

  it("keeps channel chat triggers discoverable for workspace agents", async () => {
    const { defineAgent, withWorkspaceAgentDefaults } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      capabilities: [{ id: "custom" }],
      channels: { web: webChat() },
      run: () => "ok",
      workspace: {},
    })
    const registered = withWorkspaceAgentDefaults(agent as never, { workspace: "docs" })

    await expect(resolveAgentTriggers(registered, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        capabilityId: "chat",
      },
    })
  })

  it("keeps generated webhook ids unique for channel webhook arrays", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      channels: {
        support: http({
          webhooks: [
            { path: "/api/support/primary" },
            { path: "/api/support/fallback" },
          ],
        }),
      },
      run: () => "ok",
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: [{
          id: "support-1",
          path: "/api/support/primary",
          provider: "http",
        }, {
          id: "support-2",
          path: "/api/support/fallback",
          provider: "http",
        }],
      },
    })
  })

  it("does not infer webhooks for channels with webhooks disabled", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { teams } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      channels: {
        support: teams({
          adapter: () => ({}) as never,
          webhooks: false,
        }),
      },
      run: () => "ok",
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: undefined,
      },
    })
  })

  it("preserves channel ids for same-kind webhook registrations", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { teams } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      channels: {
        sales: teams({ adapter: () => ({}) as never }),
        support: teams({ adapter: () => ({}) as never }),
      },
      run: () => "ok",
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: expect.arrayContaining([
          expect.objectContaining({ channelId: "sales", id: "sales", provider: "teams" }),
          expect.objectContaining({ channelId: "support", id: "support", provider: "teams" }),
        ]),
      },
    })
  })

  it("applies channel-local message settings for one message-shaped channel", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")

    const agent = defineAgent({
      channels: {
        web: webChat({
          messages: {
            history: false,
            sessions: false,
          },
        }),
      },
      run: () => "ok",
    })

    expect(agent.chat).toMatchObject({
      history: false,
      sessions: false,
    })
  })

  it("rejects channel-local message settings across multiple message-shaped channels", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { teams, webChat } = await import("../src/channels.ts")

    expect(() => defineAgent({
      channels: {
        teams: teams({ adapter: () => ({}) as never }),
        web: webChat({ messages: { history: false } }),
      },
      run: () => "ok",
    })).toThrow("Channel-local messages options are only supported when an Agent defines one message-shaped Channel")
  })

  it("rejects channel-local identity across multiple message-shaped channels", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { teams, webChat } = await import("../src/channels.ts")

    expect(() => defineAgent({
      channels: {
        teams: teams({
          adapter: () => ({}) as never,
          identity: () => "team:user",
        }),
        web: webChat(),
      },
      run: () => "ok",
    })).toThrow("Channel-local identity resolvers are only supported when an Agent defines one message-shaped Channel")
  })

  it("rejects mixing channels with the legacy chat capability", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { webChat } = await import("../src/channels.ts")

    expect(() => defineAgent({
      capabilities: [chat()],
      channels: { web: webChat() },
      run: () => "ok",
    })).toThrow("defineAgent({ channels }) cannot be combined with the chat() capability")
  })

  it("runs agent finish hooks for custom object results after extensions are resolved", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        {
          id: "first",
          output(context) {
            context.finish.provide((event: { result?: unknown }) => `${(event.result as { text: string }).text}:first`)
          },
        },
        {
          id: "second",
          output(context) {
            context.finish.provide({ value: "second-value" })
          },
        },
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "ok" }),
    })
    const input = { prompt: "hello" }

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, input)).resolves.toMatchObject({ text: "ok" })

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      input,
      invocation: expect.objectContaining({
        durationMs: expect.any(Number),
        run: { runId: "run-1" },
      }),
      result: { text: "ok" },
      runtime: expect.objectContaining({ runtime: "unknown" }),
    }))
    const event = finish.mock.calls[0]![0]
    expect(event.extensions.get("first")).toBe("ok:first")
    expect(event.extensions.get("second")).toEqual({ value: "second-value" })
    expect(event.extensions.get("second", "value")).toBe("second-value")
    expect(event.extensions.get("first", "length")).toBeUndefined()
    expect(event.extensions.get("missing")).toBeUndefined()
  })

  it("skips finish extension providers when no finish hook is registered", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const extension = vi.fn(() => {
      throw new Error("extension should not run")
    })
    const agent = defineAgent({
      capabilities: [{
        id: "unused",
        output(context) {
          context.finish.provide(extension)
        },
      }],
      run: () => ({ text: "ok" }),
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).resolves.toMatchObject({ text: "ok" })
    expect(extension).not.toHaveBeenCalled()
  })

  it("does not rerun finish lifecycle when a finish hook fails", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finishError = new Error("finish failed")
    const extension = vi.fn(() => "extension-value")
    const finish = vi.fn(() => {
      throw finishError
    })
    const agent = defineAgent({
      capabilities: [{
        id: "finish-extension",
        output(context) {
          context.finish.provide(extension)
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "ok" }),
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("finish failed")
    expect(extension).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs agent finish hooks for model-backed object results", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return await this.generate()
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [{
        id: "finish-metadata",
        output(context) {
          context.output.render(result => ({ ...result as Record<string, unknown>, finishMetadata: { id: "rendered-1" } }))
          context.finish.provide((event: { result?: unknown }) => (event.result as { finishMetadata?: unknown }).finishMetadata)
        },
      }],
        hooks: {
          "agent:finish": finish,
        },
        model: {} as never,
      })

      await expect(runAgent(agent, {
        memo: vi.fn(),
        run: { runId: "run-model-1" },
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})).resolves.toMatchObject({ finishReason: "stop", text: "ok" })

      expect(finish).toHaveBeenCalledWith(expect.objectContaining({
        extensions: expect.objectContaining({
          get: expect.any(Function),
        }),
        invocation: expect.objectContaining({
          run: { runId: "run-model-1" },
        }),
        result: expect.objectContaining({ finishMetadata: { id: "rendered-1" }, finishReason: "stop", text: "ok" }),
      }))
      expect(finish.mock.calls[0]![0].extensions.get("finish-metadata")).toEqual({ id: "rendered-1" })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("runs stream finish hooks with rendered model-backed object results", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return await this.generate()
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [{
          id: "usage",
          output(context) {
            context.output.render(result => ({ ...result as Record<string, unknown>, usageRecord: { id: "usage-1" } }))
          },
        }],
        hooks: {
          "agent:finish": finish,
        },
        model: {} as never,
      })

      const stream = await streamAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})

      for await (const _event of stream as AsyncIterable<unknown>) {}

      expect(finish).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.objectContaining({ usageRecord: { id: "usage-1" } }),
      }))
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("runs agent finish hooks after generated streams are consumed", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const agent = defineAgent({
      hooks: {
        "agent:finish": () => { order.push("finish") },
      },
      run: () => (async function* () {
        yield "hello"
        order.push("stream:done")
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(order).toEqual([])
    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(order).toEqual(["stream:done", "finish"])
  })

  it("runs finish lifecycle when async stream output renderer setup fails", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const renderError = new Error("render failed")
    const agent = defineAgent({
      capabilities: [{
        id: "broken-renderer",
        output(context) {
          context.output.render(() => {
            throw renderError
          })
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      run: () => (async function* () {
        yield "hello"
      })(),
    })

    await expect(streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("render failed")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error: renderError,
    }))
  })

  it("emits chat title data for the first user message in streams", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const execute = vi.fn(({ text }) => `Title: ${text}`)
    const agent = defineAgent({
      capabilities: [chatTitle({ execute })],
      run: () => (async function* () {
        yield { text: "hello", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [
        createMessage({ id: "assistant-1", role: "assistant", text: "Earlier reply" }),
        createMessage({ id: "user-1", role: "user", text: "First user request" }),
        createMessage({ id: "user-2", role: "user", text: "Latest user request" }),
      ],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ id: "user-1" }),
      text: "First user request",
    }))
    expect(events).toContainEqual({
      data: { title: "Title: First user request", type: "chat-title" },
      type: "data",
    })
    expect(events).toContainEqual({ text: "hello", type: "text-delta" })
    expect(events).toContainEqual({ type: "finish" })
  })

  it("streams agent output while chat title generation is pending", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    let resolveTitle: (title: string) => void = () => {}
    const delayedTitle = new Promise<string>((resolve) => {
      resolveTitle = resolve
    })
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => delayedTitle })],
      run: () => (async function* () {
        yield { text: "hello", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    }) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { text: "hello", type: "text-delta" },
    })

    resolveTitle("Delayed title")
    const rest = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<unknown>) {
      rest.push(event)
    }

    expect(rest).toContainEqual({ type: "finish" })
    expect(rest).toContainEqual({
      data: { title: "Delayed title", type: "chat-title" },
      type: "data",
    })
  })

  it("keeps streaming when chat title generation fails", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => { throw new Error("title failed") } })],
      run: () => (async function* () {
        yield { text: "hello", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "hello", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("generates chat titles with the default template and agent model", async () => {
    const generateText = vi.fn(async () => ({ text: '"Generated invoice title"' }))
    vi.doMock("ai", () => ({ generateText }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [chatTitle()],
        hooks: {
          "agent:finish": finish,
        },
        model: "agent-title-model" as never,
        run: () => ({ text: "ok" }),
      })

      await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
        messages: [createMessage({ role: "user", text: "Need help with invoices" })],
      })

      expect(generateText).toHaveBeenCalledWith({
        model: "agent-title-model",
        prompt: [
          "Generate a short chat title from the user's first message.",
          "Return only the title.",
          "Use 2-5 words when possible.",
          `Use "New Conversation" when the message is too vague.`,
          "",
          "User message:",
          "Need help with invoices",
        ].join("\n"),
      })
      expect(finish.mock.calls[0]![0].extensions.get("chat-title")).toEqual({ title: "Generated invoice title" })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("renders custom chat title templates and skips unmatched triggers", async () => {
    const generateText = vi.fn(async () => ({ text: "Portal Forecast Help" }))
    vi.doMock("ai", () => ({ generateText }))

    try {
      const { defineAgent, runAgentTrigger } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [
          chatTitle({
            model: "title-model" as never,
            template: "{{ trigger }} {{ area }}: {{ message }}",
            trigger: "portal.message",
            variables: {
              area: "support",
            },
          }),
          {
            id: "portal",
            triggers: {
              message: {
                invoke: (_context, input: { text: string }) => ({
                  input: { messages: [createMessage({ role: "user", text: input.text })] },
                }),
              },
            },
          },
          {
            id: "teams",
            triggers: {
              message: {
                invoke: (_context, input: { text: string }) => ({
                  input: { messages: [createMessage({ role: "user", text: input.text })] },
                }),
              },
            },
          },
        ],
        hooks: {
          "agent:finish": finish,
        },
        run: () => ({ text: "ok" }),
      })
      const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

      await runAgentTrigger(agent, runtime, "teams.message", { text: "Need help with forecast" })
      expect(generateText).not.toHaveBeenCalled()
      expect(finish.mock.calls[0]![0].extensions.get("chat-title")).toBeUndefined()

      await runAgentTrigger(agent, runtime, "portal.message", { text: "Need help with forecast" })

      expect(generateText).toHaveBeenCalledWith({
        model: "title-model",
        prompt: "portal.message support: Need help with forecast",
      })
      expect(finish.mock.calls[1]![0].extensions.get("chat-title")).toEqual({ title: "Portal Forecast Help" })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("emits chat title data for adapter text streams", async () => {
    vi.doMock("ai", () => ({
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return {
            textStream: (async function* () {
              yield "hello"
            })(),
          }
        }
      },
      stepCountIs: () => () => false,
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [chatTitle({ execute: () => "Adapter title" })],
        model: {} as never,
      })

      const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
        messages: [createMessage({ role: "user", text: "First user request" })],
      })
      const events = []
      for await (const event of stream as AsyncIterable<unknown>) {
        events.push(event)
      }

      expect(events).toContainEqual({ data: { title: "Adapter title", type: "chat-title" }, type: "data" })
      expect(events).toContainEqual({ text: "hello", type: "text-delta" })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("preserves stream result methods when adding chat title data to full streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class StreamResult {
      metadata = { id: "stream-result-1" }
      fullStream = (async function* () {
        yield { text: "hello", type: "text-delta" }
      })()

      toTextStreamResponse() {
        return new Response("native")
      }
    }
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Preserved title" })],
      hooks: {
        "agent:finish": finish,
      },
      run: () => new StreamResult(),
    })

    const result = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    }) as StreamResult
    const events = []
    for await (const event of result.fullStream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ data: { title: "Preserved title", type: "chat-title" }, type: "data" })
    expect(events).toContainEqual({ text: "hello", type: "text-delta" })
    expect(result).toBeInstanceOf(StreamResult)
    expect(result.metadata).toEqual({ id: "stream-result-1" })
    expect(result.toTextStreamResponse).toEqual(expect.any(Function))
    await expect(result.toTextStreamResponse().text()).resolves.toBe("native")
    expect(finish.mock.calls[0]![0].result).toBe(result)
  })

  it("preserves text stream result metadata when adding chat title data", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class TextStreamResult {
      metadata = { usage: "kept" }
      textStream = (async function* () {
        yield "hello"
      })()

      toTextStreamResponse() {
        return new Response("native text")
      }
    }
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Metadata title" })],
      hooks: {
        "agent:finish": finish,
      },
      run: () => new TextStreamResult(),
    })

    const result = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    }) as TextStreamResult & { fullStream?: AsyncIterable<unknown> }
    const events = []
    for await (const event of result.fullStream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ data: { title: "Metadata title", type: "chat-title" }, type: "data" })
    expect(events).toContainEqual({ text: "hello", type: "text-delta" })
    expect(result).toBeInstanceOf(TextStreamResult)
    expect(result.metadata).toEqual({ usage: "kept" })
    expect(result.textStream).toBeDefined()
    expect(result.fullStream).toBeDefined()
    await expect(result.toTextStreamResponse().text()).resolves.toBe("native text")
    expect(finish.mock.calls[0]![0].result).toBe(result)
  })

  it("emits chat title data for UI message streams", async () => {
    const { createUIMessageStream, readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Sidebar title" })],
      run: () => ({
        toUIMessageStream() {
          return createUIMessageStream({
            execute({ writer }) {
              writer.write({ type: "start", messageId: "assistant-1" })
              writer.write({ type: "text-start", id: "text-1" })
              writer.write({ type: "text-delta", id: "text-1", delta: "answer" })
              writer.write({ type: "text-end", id: "text-1" })
              writer.write({ type: "finish", finishReason: "stop" })
            },
          })
        },
      }),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain availability" })],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messages.at(-1)?.parts).toEqual([
      { data: { title: "Sidebar title", type: "chat-title" }, type: "data-chat-title" },
      { providerMetadata: undefined, state: "done", text: "answer", type: "text" },
    ])
  })

  it("does not read text getters when streaming native UI message results", async () => {
    const { createUIMessageStream, readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      run: () => ({
        get text() {
          throw new Error("text getter should not be read")
        },
        toUIMessageStream() {
          return createUIMessageStream({
            execute({ writer }) {
              writer.write({ type: "start", messageId: "assistant-1" })
              writer.write({ type: "text-start", id: "text-1" })
              writer.write({ type: "text-delta", id: "text-1", delta: "answer" })
              writer.write({ type: "text-end", id: "text-1" })
              writer.write({ type: "finish", finishReason: "stop" })
            },
          })
        },
      }),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain availability" })],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messages.at(-1)?.parts).toEqual([
      { providerMetadata: undefined, state: "done", text: "answer", type: "text" },
    ])
  })

  it("emits one chat title data part when async event streams become UI message streams", async () => {
    const { readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Async title" })],
      run: () => (async function* () {
        yield { text: "answer", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain availability" })],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messages.at(-1)?.parts.filter(part => part.type === "data-chat-title")).toEqual([
      { data: { title: "Async title", type: "chat-title" }, type: "data-chat-title" },
    ])
    expect(messages.at(-1)?.parts.map(part => part.type).sort()).toEqual(["data-chat-title", "text"])
  })

  it("renders custom async event streams returned from runAgent", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Run title" })],
      run: () => (async function* () {
        yield { text: "answer", type: "text-delta" }
        yield { type: "finish" }
      })(),
    })

    const result = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain availability" })],
    }) as AsyncIterable<unknown>
    const events = []
    for await (const event of result) {
      events.push(event)
    }

    expect(events).toContainEqual({ data: { title: "Run title", type: "chat-title" }, type: "data" })
    expect(events).toContainEqual({ text: "answer", type: "text-delta" })
  })

  it("exposes chat title finish extension without registering command metadata", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: ({ text }) => ({ title: `Title: ${text}` }) })],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({ text: "ok" }),
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "Explain invoices" })],
    })

    const event = finish.mock.calls[0]![0]
    expect(event.extensions.get("chat-title")).toEqual({ title: "Title: Explain invoices" })
    expect(agent.capabilities?.[0]?.metadata).toBeUndefined()
  })

  it("runs agent finish hooks after Response bodies are read", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response("ok"),
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}) as Response
    expect(finish).not.toHaveBeenCalled()
    await expect(response.text()).resolves.toBe("ok")
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs agent finish hooks with Response body read errors", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const error = new Error("upstream failed")
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response(new ReadableStream({
        pull() {
          throw error
        },
      })),
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}) as Response
    await expect(response.text()).rejects.toThrow("upstream failed")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error,
    }))
    expect(finish.mock.calls[0]![0]).not.toHaveProperty("result")
  })

  it("runs agent finish hooks when Response bodies are canceled", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"))
        },
      })),
    })

    const response = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {}) as Response
    await response.body?.cancel()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("runs agent finish hooks when Response wrapping fails", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const body = new ReadableStream()
    body.getReader()
    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      run: () => new Response(body),
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(TypeError),
    }))
    expect(finish.mock.calls[0]![0]).not.toHaveProperty("result")
  })

  it("returns generated Response results unchanged", async () => {
    const { runAgent } = await import("../src/index.ts")
    const response = Response.json({ ok: true })
    const agent = {
      generate: vi.fn(async () => response),
      name: "response-agent",
    }

    await expect(runAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toBe(response)
  })

  it("returns streamed Response results unchanged", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const response = new Response("ok")
    const agent = {
      generate: vi.fn(),
      name: "response-agent",
      stream: vi.fn(async () => response),
    }

    await expect(streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })).resolves.toBe(response)
  })

  it("converts text streams into ViteHub stream events", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        textStream: (async function* () {
          yield "hel"
          yield "lo"
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "hel", type: "text-delta" },
      { text: "lo", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("converts generate-only text results into ViteHub stream events", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(async () => ({ finishReason: "stop", text: "generated text" })),
      name: "generate-only-agent",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "generated text", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("converts generate-only string results into ViteHub stream events", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(async () => "generated string"),
      name: "generate-only-agent",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "generated string", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("creates a new DevTools assistant placeholder for each turn", async () => {
    const { createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const first = adapter.createDevtoolsMessage("first")

    await adapter.startTyping(first.threadId, "thinking")
    await adapter.postMessage(first.threadId, "first response")
    const second = adapter.createDevtoolsMessage("second")
    await adapter.startTyping(second.threadId, "thinking again")

    expect(adapter.getDevtoolsState().chats[0]?.messages.map(message => ({
      loading: message.loading,
      role: message.role,
      text: message.text,
    }))).toEqual([
      { loading: undefined, role: "user", text: "first" },
      { loading: false, role: "assistant", text: "first response" },
      { loading: undefined, role: "user", text: "second" },
      { loading: true, role: "assistant", text: "thinking again" },
    ])
  })

  it("attaches late DevTools tool updates to the assistant response", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const message = adapter.createDevtoolsMessage("list files")

    await adapter.startTyping(message.threadId, "thinking")
    await adapter.postMessage(message.threadId, "I checked the workspace.")
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      input: { command: "ls" },
      name: "shell",
      output: "README.md",
      status: "completed",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages).toMatchObject([
      { role: "user", text: "list files" },
      {
        loading: false,
        role: "assistant",
        text: "I checked the workspace.",
        tools: [
          {
            id: "tool-1",
            input: { command: "ls" },
            name: "shell",
            output: "README.md",
            status: "completed",
          },
        ],
      },
    ])
  })

  it("keeps DevTools fallback text while tools stream", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const message = adapter.createDevtoolsMessage("list users")

    await adapter.startTyping(message.threadId, "Looking through the workspace...")
    await adapter.startTyping(message.threadId, "...")
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      input: { command: "find . -maxdepth 3 -name \"*user*\"" },
      name: "shell",
      status: "running",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages).toMatchObject([
      { role: "user", text: "list users" },
      {
        loading: true,
        role: "assistant",
        text: "Looking through the workspace...",
        tools: [
          {
            id: "tool-1",
            name: "shell",
            status: "running",
          },
        ],
      },
    ])

    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      name: "shell",
      output: "users.ts",
      status: "completed",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages[1]).toMatchObject({
      loading: true,
      role: "assistant",
      text: "Looking through the workspace...",
      tools: [
        {
          id: "tool-1",
          input: { command: "find . -maxdepth 3 -name \"*user*\"" },
          name: "shell",
          output: "users.ts",
          status: "completed",
        },
      ],
    })

    await adapter.postMessage(message.threadId, "I found the user tables.")

    expect(adapter.getDevtoolsState().chats[0]?.messages[1]).toMatchObject({
      loading: false,
      role: "assistant",
      text: "I found the user tables.",
      tools: [
        {
          id: "tool-1",
          name: "shell",
          status: "completed",
        },
      ],
    })
  })

  it("keeps separate no-input DevTools tool calls", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const message = adapter.createDevtoolsMessage("run checks")

    await adapter.startTyping(message.threadId, "thinking")
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      name: "check",
      output: "first",
      status: "completed",
    }))
    await adapter.startTyping(message.threadId, createChatDevtoolsToolStatus({
      id: "tool-2",
      name: "check",
      output: "second",
      status: "completed",
    }))

    expect(adapter.getDevtoolsState().chats[0]?.messages[1]?.tools).toMatchObject([
      { id: "tool-1", name: "check", output: "first" },
      { id: "tool-2", name: "check", output: "second" },
    ])
  })

  it("creates a fresh assistant entry for tool-first DevTools turns", async () => {
    const { createChatDevtoolsToolStatus, createDevtoolsAdapter } = await import("../src/chat/devtools.ts")
    const adapter = createDevtoolsAdapter()
    const first = adapter.createDevtoolsMessage("first")

    await adapter.startTyping(first.threadId, "thinking")
    await adapter.postMessage(first.threadId, "first response")
    const second = adapter.createDevtoolsMessage("second")
    await adapter.startTyping(second.threadId, createChatDevtoolsToolStatus({
      id: "tool-1",
      name: "lookup",
      status: "running",
    }))

    const messages = adapter.getDevtoolsState().chats[0]?.messages
    expect(messages).toMatchObject([
      { role: "user", text: "first" },
      { role: "assistant", text: "first response" },
      { role: "user", text: "second" },
      {
        loading: true,
        role: "assistant",
        tools: [{ id: "tool-1", name: "lookup", status: "running" }],
      },
    ])
    expect(messages?.[1]?.tools).toBeUndefined()
  })

  it("registers the Chat DevTools feature metadata", async () => {
    const registerViteHubDevtoolsFeature = vi.fn()
    vi.resetModules()
    vi.doMock("@vite-hub/devtools", () => ({ registerViteHubDevtoolsFeature }))
    const { chatDevToolsPanel } = await import("../src/chat/devtools.ts")

    chatDevToolsPanel().devtools!.setup({
      messages: {
        add: vi.fn(),
      },
      rpc: {
        register: vi.fn(),
      },
    } as never)

    expect(registerViteHubDevtoolsFeature).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      bridge: "/__vitehub/agent/chat/devtools",
      id: "agent.chat",
      packageName: "@vite-hub/agent",
      title: "Chat",
    }))
    vi.doUnmock("@vite-hub/devtools")
    vi.resetModules()
  })

  it("selects chat history from the current idle-timeout session", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat({
        history: { maxMessages: 10, source: "thread" },
        sessions: { idleTimeoutMs: 30 * 60 * 1000, strategy: "idle-timeout" },
      })],
      run: () => "ok",
    })

    const invocation = await resolveAgentTriggerInvocation(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [
        { createdAt: "2026-05-28T10:00:00.000Z", parts: [{ text: "old topic", type: "text" }], role: "user" },
        { createdAt: "2026-05-28T10:00:10.000Z", parts: [{ text: "old answer", type: "text" }], role: "assistant" },
        { createdAt: "2026-05-28T11:00:00.000Z", parts: [{ text: "new topic", type: "text" }], role: "user" },
      ],
    })

    expect(invocation.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["new topic"])
  })

  it("defaults zero-argument chat options and preserves completed UI tool calls", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat()],
      run: () => "ok",
    })

    const invocation = await resolveAgentTriggerInvocation(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [{
        parts: [{
          input: { query: "users" },
          output: "42",
          state: "output-available",
          toolCallId: "tool-1",
          toolName: "search",
          type: "dynamic-tool",
        }],
        role: "assistant",
      }],
    })

    expect(invocation.input.messages?.[0]?.parts).toEqual([
      { id: "tool-1", input: { query: "users" }, name: "search", state: "proposed", type: "tool-call" },
      { id: "tool-1", name: "search", output: "42", state: "completed", type: "tool-result" },
    ])
  })

  it("converts async stream events to AI SDK UI message streams", async () => {
    const { readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      run: () => (async function* () {
        yield { data: { title: "Async title", type: "chat-title" }, type: "data" }
        yield { text: "hello", type: "text-delta" }
        yield { id: "tool-1", input: { query: "users" }, name: "search", type: "tool-call" }
        yield { id: "tool-1", name: "search", output: "42", type: "tool-result" }
        yield { type: "finish" }
      })(),
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "hello" })],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messages.at(-1)?.parts.map(part => part.type)).toEqual(["data-chat-title", "text", "tool-search"])
    expect(messages.at(-1)?.parts[0]).toEqual({
      data: { title: "Async title", type: "chat-title" },
      type: "data-chat-title",
    })
  })

  it("selects chat history from the requested manual session", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat({
        history: { maxMessages: 10, source: "thread" },
        sessions: true,
      })],
      run: () => "ok",
    })

    const invocation = await resolveAgentTriggerInvocation(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [
        { metadata: { sessionId: "a" }, parts: [{ text: "session a", type: "text" }], role: "user" },
        { metadata: { sessionId: "b" }, parts: [{ text: "session b", type: "text" }], role: "user" },
      ],
      session: { id: "b" },
      user: { id: "user_1" },
    })

    expect(invocation.input.context?.chat).toMatchObject({
      session: { id: "b" },
      user: { id: "user_1" },
    })
    expect(invocation.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["session b"])
  })

  it("preserves falsy streamed tool inputs and outputs", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { input: false, toolCallId: "call-1", toolName: "confirm", type: "tool-input-available" }
          yield { output: 0, toolCallId: "call-1", type: "tool-output-available" }
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: "call-1", input: false, name: "confirm", type: "tool-call" },
      { error: undefined, id: "call-1", name: "confirm", output: 0, type: "tool-result" },
      { type: "finish" },
    ])
  })

  it("maps streamed AI SDK tool output errors to tool result errors", async () => {
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { input: { query: "stock" }, toolCallId: "call-1", toolName: "search", type: "tool-input-available" }
          yield { errorText: "lookup failed", toolCallId: "call-1", type: "tool-output-error" }
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "hello" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: "call-1", input: { query: "stock" }, name: "search", type: "tool-call" },
      { error: "lookup failed", id: "call-1", name: "search", output: undefined, type: "tool-result" },
      { type: "finish" },
    ])
  })

  it("maps approval-required stream errors to approval request events", async () => {
    const { ApprovalRequiredError } = await import("@vite-hub/runtime")
    const { streamAgent } = await import("../src/index.ts")
    const agent = {
      generate: vi.fn(),
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield {
            error: new ApprovalRequiredError({
              capability: "refund",
              id: "approval-1",
              input: { orderId: "ord_123" },
              reason: "Refunds require review",
              state: "awaiting-approval",
            }),
            type: "error",
          }
        })(),
      })),
      tools: {},
      version: "agent-v1",
    }

    const stream = await streamAgent(agent as never, {} as never, {
      messages: [createMessage({ role: "user", text: "refund order" })],
    })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        id: "approval-1",
        input: { orderId: "ord_123" },
        name: "refund",
        reason: "Refunds require review",
        type: "approval-request",
      },
      { type: "finish" },
    ])
  })

  it("resolves tools with runtime capability handles", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      model: {} as never,
      capabilities: [{
        id: "inspect",
        tools: context => ({
          inspect: {
            name: "inspect",
            execute: async () => context.capabilities?.sandbox,
          },
        }),
      }],
    })

    const resolved = await agent.resolve({
      capabilities: { sandbox: { kind: "sandbox", value: { id: "sb_1" } } },
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    })

    expect(resolved).toEqual(expect.any(Object))
  })

  it("prevents denied tools from executing", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const execute = vi.fn()

    const agent = defineAgent({
      model: {} as never,
      capabilities: [{
        id: "refund-tools",
        tools: {
          refund: {
            execute,
            name: "refund",
            policy: "deny",
          },
        },
      }],
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.refund!.execute({ amount: 100 })).rejects.toThrow("Capability \"refund\" was denied")
    expect(execute).not.toHaveBeenCalled()
  })

  it("turns approval-required tool policy into an approval error", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const execute = vi.fn()

    const agent = defineAgent({
      model: {} as never,
      capabilities: [{
        id: "refund-tools",
        tools: {
          refund: {
            execute,
            name: "refund",
            policy: "require-approval",
          },
        },
      }],
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.refund!.execute({ amount: 100 })).rejects.toMatchObject({
      request: {
        capability: "refund",
        input: { amount: 100 },
        state: "awaiting-approval",
      },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it("validates capability ids and sandbox commands", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { sandbox, workspaceShell } = await import("../src/capabilities.ts")

    expect(() => defineAgent({
      capabilities: [{ id: "custom" }, { id: "custom" }],
      model: {} as never,
    })).toThrow("Duplicate capability id")

    expect(() => defineAgent({
      capabilities: [{} as never],
      model: {} as never,
    })).toThrow("require a non-empty string id")

    expect(() => defineAgent({
      capabilities: [sandbox({ commands: ["pnpm test"] })],
      model: {} as never,
      workspace: {},
    })).toThrow("executable names only")

    expect(() => defineAgent({
      capabilities: [workspaceShell()],
      model: {} as never,
    })).toThrow("requires an explicit workspace")

    expect(() => defineAgent({
      capabilities: [workspaceShell({ mode: "write" })],
      model: {} as never,
      workspace: { mode: "read" },
    })).toThrow("requires workspace.mode")
  })

  it("fails when a primitive capability has no backing primitive", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { kv } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [kv()],
      model: {} as never,
    })

    await expect(agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() })).rejects.toThrow("requires the kv primitive")
  })

  describe("workflow-backed agents", () => {
    afterEach(async () => {
      const { resetWorkflowRuntime } = await import("@vite-hub/workflow/runtime/state")
      resetWorkflowRuntime()
    })

    it("streams workflow-backed chat triggers inline for DevTools", async () => {
      const { createUIMessageStream, readUIMessageStream } = await import("ai")
      const { defineAgent, streamAgentTrigger, workflow } = await import("../src/index.ts")

      const agent = defineAgent({
        capabilities: [chat()],
        runtime: workflow("support-agent"),
        run: () => ({
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: "assistant-1" })
                writer.write({ type: "text-start", id: "text-1" })
                writer.write({ type: "text-delta", id: "text-1", delta: "pong" })
                writer.write({ type: "text-end", id: "text-1" })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }),
      })

      const stream = await streamAgentTrigger(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, "chat.message", {
        messages: [createMessage({ role: "user", text: "Say pong only." })],
      }, { output: "ui-message-stream" }) as ReadableStream<never>
      const messages = []
      for await (const message of readUIMessageStream({ stream })) {
        messages.push(message)
      }

      expect(messages.at(-1)?.parts).toEqual([
        { providerMetadata: undefined, state: "done", text: "pong", type: "text" },
      ])
    })

    it("queues direct agent runs as Workflow Runs", async () => {
      const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const agent = defineAgent({
        runtime: workflow("support-agent"),
        run: context => `received ${context.prompt}`,
      })
      const run = await runAgent(agent, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, { prompt: "hello" }) as { id: string }

      expect(run).toMatchObject({
        provider: "vercel",
        status: "queued",
      })
      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("support-agent", run.id)).resolves.toMatchObject({
        result: "received hello",
        status: "completed",
      })
    })

    it("reuses generated workflow definitions across equivalent agent instances", async () => {
      const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const run = (context: { prompt?: string }) => `received ${context.prompt}`
      const firstAgent = defineAgent({
        runtime: workflow("support-agent"),
        run,
      })
      const secondAgent = defineAgent({
        runtime: workflow("support-agent"),
        run,
      })

      const first = await runAgent(firstAgent, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, { prompt: "first" }) as { id: string }
      const second = await runAgent(secondAgent, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, { prompt: "second" }) as { id: string }

      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("support-agent", first.id)).resolves.toMatchObject({
        result: "received first",
        status: "completed",
      })
      await expect(getWorkflowRun("support-agent", second.id)).resolves.toMatchObject({
        result: "received second",
        status: "completed",
      })
    })

    it("uses trigger run ids as workflow run ids", async () => {
      const { defineAgent, runAgentTrigger, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const agent = defineAgent({
        capabilities: [{
          id: "portal",
          triggers: {
            message: {
              invoke: (_context, input: { text: string }) => ({
                input: { prompt: input.text },
                run: { origin: "portal", runId: "portal-run" },
              }),
            },
          },
        }],
        runtime: workflow("portal-agent"),
        run: context => `received ${context.prompt}`,
      })
      const run = await runAgentTrigger(agent, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, "portal.message", { text: "hello" }) as { id: string }

      expect(run).toMatchObject({
        id: "portal-run",
        provider: "vercel",
        status: "queued",
      })
      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("portal-agent", "portal-run")).resolves.toMatchObject({
        result: "received hello",
        status: "completed",
      })
    })

    it("passes Cloudflare env through workflow inline fallback", async () => {
      const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "cloudflare" })

      const agent = defineAgent({
        runtime: workflow("cloudflare-agent"),
        run: context => context.cloudflare?.env?.NUXT_SITE,
      })
      const run = await runAgent(agent, {
        cloudflare: { env: { NUXT_SITE: "nuxt.com" } },
        memo: vi.fn(),
        runtime: "cloudflare-agents",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, {}) as { id: string }

      expect(run).toMatchObject({
        provider: "cloudflare",
        status: "queued",
      })
      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("cloudflare-agent", run.id)).resolves.toMatchObject({
        result: "nuxt.com",
        status: "completed",
      })
    })
  })
})
