import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMessage, getMessageText } from "@vite-hub/agent"
import { createTraceEventLog, deriveTraceRuns, emitTraceEvent } from "@vite-hub/runtime"
import { chat, chatTitle, observability, schedule, subagents } from "../src/capabilities.ts"
import { toJsonCompatibleValue } from "../src/tool-runtime.ts"

import type { WritableWorkspaceFacade } from "@vite-hub/workspace"

const harnessAgentSettings = vi.hoisted(() => [] as Record<string, unknown>[])
const harnessCreateSession = vi.hoisted(() => vi.fn())
const harnessGenerate = vi.hoisted(() => vi.fn())
const harnessStream = vi.hoisted(() => vi.fn())
const vercelSandboxSettings = vi.hoisted(() => [] as Record<string, unknown>[])

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

vi.mock("@ai-sdk/sandbox-vercel", () => ({
  createVercelSandbox(settings: Record<string, unknown>) {
    vercelSandboxSettings.push(settings)
    return { providerId: "vercel", settings }
  },
}))

const { withAgentDefaults } = await import("../src/index.ts")

afterEach(() => {
  harnessAgentSettings.length = 0
  harnessCreateSession.mockReset()
  harnessGenerate.mockReset()
  harnessStream.mockReset()
  vercelSandboxSettings.length = 0
})

describe("agent message protocol", () => {
  it("normalizes undefined tool output to JSON null", () => {
    expect(toJsonCompatibleValue(undefined)).toBeNull()
  })

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

  it("does not resolve harnessSandbox for custom Agent Drivers", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const harnessSandbox = vi.fn(() => {
      throw new Error("unused")
    })
    const agent = defineAgent({
      driver: { run: () => "ok" },
      harnessSandbox,
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toBe("ok")
    expect(harnessSandbox).not.toHaveBeenCalled()
  })

  it("runs agent input hooks once before driver execution and can abort", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const run = vi.fn(() => "ok")
    const inputHook = vi.fn((context) => {
      if (!context.input.context?.pullRequest) {
        throw new Error("Missing GitHub field: context.pullRequest")
      }
    })
    const agent = defineAgent({
      driver: { run },
      hooks: {
        "agent:input": inputHook,
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      context: { pullRequest: true as never },
      prompt: "review",
    })).resolves.toBe("ok")
    expect(inputHook).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      prompt: "review",
    })).rejects.toThrow("Missing GitHub field: context.pullRequest")
    expect(inputHook).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("emits observability events and finish extensions", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const standaloneEvents: string[] = []
    const standaloneAgent = defineAgent({
      capabilities: [
        observability({
          onEvent(event) {
            standaloneEvents.push(event.type)
          },
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(standaloneAgent, {
      memo: vi.fn(),
      run: { origin: "http", runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })).resolves.toBe("ok")

    expect(standaloneEvents).toEqual(["start", "finish"])

    const events: string[] = []
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        observability({
          onEvent(event) {
            events.push(event.type)
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { origin: "http", runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })).resolves.toBe("ok")

    expect(events).toEqual(["start", "finish"])
    expect(finish.mock.calls[0]?.[0].extensions.get("observability")).toMatchObject({
      resultKind: "string",
      status: "completed",
    })
  })

  it("enables usage telemetry from observability by default", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [observability()],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
          text: "ok",
          totalUsage: {
            inputTokens: 4,
            outputTokens: 6,
          },
        }) },
    })

    const result = await runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })

    expect(result).toMatchObject({
      text: "ok",
      usageRecord: {
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          totalTokens: 10,
        },
      },
    })
    const extensions = finish.mock.calls[0]![0].extensions
    const usage = extensions.get("usage-telemetry")
    expect(usage).toBe((result as { usageRecord?: unknown }).usageRecord)
    expect(extensions.get("observability", "usage")).toBe(usage)
  })

  it("lets observability opt out of default usage telemetry", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usageRecord = {
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    }
    const agent = defineAgent({
      capabilities: [observability({ usageTelemetry: false })],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
          text: "ok",
          usageRecord,
        }) },
    })

    const result = await runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })

    expect((result as { usageRecord?: unknown }).usageRecord).toBe(usageRecord)
    const extensions = finish.mock.calls[0]![0].extensions
    expect(extensions.get("usage-telemetry")).toBeUndefined()
    expect(extensions.get("observability", "usage")).toBeUndefined()
  })

  it("keeps observability usage opt-out order-independent with explicit usage telemetry", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const orders = [
      () => [usageTelemetry(), observability({ usageTelemetry: false })],
      () => [observability({ usageTelemetry: false }), usageTelemetry()],
    ]

    for (const capabilities of orders) {
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: capabilities(),
        hooks: {
          "agent:finish": finish,
        },
        driver: { run: () => ({
            text: "ok",
            totalUsage: {
              inputTokens: 4,
              outputTokens: 6,
            },
          }) },
      })

      const result = await runAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, { prompt: "hello" })

      expect((result as { usageRecord?: unknown }).usageRecord).toEqual(expect.objectContaining({
        usage: expect.objectContaining({
          totalTokens: 10,
        }),
      }))
      const extensions = finish.mock.calls[0]![0].extensions
      expect(extensions.get("usage-telemetry")).toBe((result as { usageRecord?: unknown }).usageRecord)
      expect(extensions.get("observability", "usage")).toBeUndefined()
    }
  })

  it("uses explicit usage telemetry configuration for observability", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()
    const onUsage = vi.fn()
    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ onUsage }),
        observability(),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
          text: "ok",
          totalUsage: {
            inputTokens: 8,
            outputTokens: 2,
          },
        }) },
    })

    await runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })

    expect(onUsage).toHaveBeenCalledTimes(1)
    const extensions = finish.mock.calls[0]![0].extensions
    const usage = extensions.get("usage-telemetry")
    expect(extensions.get("observability", "usage")).toBe(usage)
  })

  it("preserves explicit capability order over nested defaults", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [
        observability(),
        defineCapability({
          id: "usage-renderer",
          output(context) {
            context.output.render(result => ({
              ...(result as Record<string, unknown>),
              totalUsage: {
                inputTokens: 4,
                outputTokens: 6,
              },
            }))
          },
        }),
        usageTelemetry(),
      ],
      driver: { run: () => ({ text: "ok" }) },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        usage: {
          totalTokens: 10,
        },
      },
    })
  })

  it("does not let observability sink failures change Agent output", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const onEvent = vi.fn(() => {
      throw new Error("sink failed")
    })
    const agent = defineAgent({
      capabilities: [
        observability({ onEvent }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "hello" })).resolves.toBe("ok")
    expect(onEvent).toHaveBeenCalledTimes(2)
  })

  it("skips agent input hooks after a capability handles the input", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const handled = new Response("handled")
    const run = vi.fn(() => "ok")
    const inputHook = vi.fn(() => {
      throw new Error("should not run")
    })
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "handled",
          input: () => handled,
        }),
      ],
      driver: { run },
      hooks: {
        "agent:input": inputHook,
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      prompt: "review",
    })).resolves.toBe(handled)
    expect(inputHook).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("runs command input and finish hooks around agent execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const events: string[] = []
    const agent = defineAgent({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => `review:${args}`,
            hooks: {
              "agent:input"(context) {
                events.push(`command-input:${context.input.prompt}`)
              },
              "agent:finish"(context) {
                events.push(context.error ? `command-finish:error:${(context.error as Error).message}` : `command-finish:${context.result}`)
              },
            },
          },
        },
      })],
      driver: { run(context) {
          events.push(`run:${context.prompt}`)
          if (context.prompt === "review:fail") throw new Error("boom")
          return `ok:${context.prompt}`
        }, },
      hooks: {
        "agent:input"(context) {
          events.push(`agent-input:${context.input.prompt}`)
        },
        "agent:finish"(context) {
          events.push(context.error ? `agent-finish:error:${(context.error as Error).message}` : `agent-finish:${context.result}`)
        },
      },
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(runAgent(agent, runtime, { prompt: "/review pass" })).resolves.toBe("ok:review:pass")
    await expect(runAgent(agent, runtime, { prompt: "/review fail" })).rejects.toThrow("boom")

    expect(events).toEqual([
      "command-input:review:pass",
      "agent-input:review:pass",
      "run:review:pass",
      "command-finish:ok:review:pass",
      "agent-finish:ok:review:pass",
      "command-input:review:fail",
      "agent-input:review:fail",
      "run:review:fail",
      "command-finish:error:boom",
      "agent-finish:error:boom",
    ])
  })

  it("lets command finish hooks reply after agent errors", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const effects: unknown[] = []
    const agent = defineAgent({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review the request.",
            call: ({ args }) => args,
            hooks: {
              async "agent:finish"(context) {
                if (context.error) await context.message.reply("I couldn't start the review.")
              },
            },
          },
        },
      })],
      channels: {
        github: defineChannel("github", {
          effects: {
            reply(context) {
              effects.push(context.effect)
            },
          },
          messages: false,
        }),
      },
      driver: { run() {
          throw new Error("failed")
        }, },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { channelId: "github", runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { prompt: "/review please" })).rejects.toThrow("failed")

    expect(effects).toEqual([{ kind: "reply", payload: "I couldn't start the review." }])
  })

  it("emits invocation Trace Events without persisting prompt content", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, { prompt: "secret prompt" })).resolves.toBe("ok")

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.invocation.finish",
    ])
    expect(traceLog.entries()[0]!.attributes).toMatchObject({
      "input.hasPrompt": true,
      "runtime.name": "unknown",
    })
    expect(JSON.stringify(traceLog.entries())).not.toContain("secret prompt")
  })

  it("records a failed invocation when Agent Finish Hooks fail", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish": () => {
          throw new Error("finish failed")
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("finish failed")

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.invocation.error",
    ])
    expect(traceLog.entries()[1]!.attributes).toMatchObject({
      "error.message": "finish failed",
    })
  })

  it("exposes normalized error messages on failed finish events", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const throwingGetterError = Object.defineProperty({}, "message", {
      get() {
        throw new Error("getter failed")
      },
    })
    const throwingPrototypeError = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("prototype failed")
      },
    })
    const cases: { error: unknown, message: string }[] = [
      { error: undefined, message: "Unknown error." },
      { error: "", message: "Unknown error." },
      { error: "string failed", message: "string failed" },
      { error: { code: "E_OBJECT", message: "object failed" }, message: "object failed" },
      { error: { code: "E_OBJECT" }, message: "Unknown error." },
      { error: throwingGetterError, message: "Unknown error." },
      { error: throwingPrototypeError, message: "Unknown error." },
      { error: Object.assign(new Error("error failed"), { name: "CustomError" }), message: "error failed" },
    ]

    for (const { error, message } of cases) {
      const finish = vi.fn()
      const agent = defineAgent({
        driver: { run: () => {
            throw error
          }, },
        hooks: { "agent:finish": finish },
      })

      await runAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {}).catch(() => {})

      const finishEvent = finish.mock.calls[0]?.[0]
      expect(finishEvent?.error).toBe(error)
      expect(finishEvent).toMatchObject({ errorMessage: message })
    }
  })

  it("uses error messages as the failed finish signal", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const onEvent = vi.fn()
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [observability({ onEvent })],
      driver: { run: () => {
          throw undefined
        }, },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {}).catch(() => {})

    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "failed",
      type: "error",
    }))
    expect(finish.mock.calls[0]?.[0].extensions.get("observability")).toMatchObject({
      status: "failed",
    })
  })

  it("treats stream cancellation without reason as successful cleanup", async () => {
    const { withReadableStreamCleanup } = await import("../src/stream-output.ts")
    const outcomes: unknown[] = []
    const stream = withReadableStreamCleanup(new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "start" })
      },
    }), async outcome => { outcomes.push(outcome) })

    await stream.cancel()

    expect(outcomes).toEqual([{ failed: false }])
  })

  it("propagates post-chunk UI message response read failures", async () => {
    const { createAgentUIMessageStreamResponse } = await import("../src/stream-output.ts")
    const error = new Error("upstream failed")
    let read = false
    const response = createAgentUIMessageStreamResponse({
      stream: new ReadableStream({
        pull(controller) {
          if (read) throw error
          read = true
          controller.enqueue({ text: "partial", type: "text-delta" })
        },
      }),
    })

    await expect(response.text()).rejects.toThrow("upstream failed")
  })

  it("records a failed invocation when failure cleanup also fails", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => {
          throw new Error("run failed")
        }, },
      hooks: {
        "agent:finish": () => {
          throw new Error("finish failed")
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("Agent run failed")

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.invocation.error",
    ])
    expect(deriveTraceRuns(traceLog.entries())).toMatchObject([
      { status: "failed" },
    ])
  })

  it("keeps custom Trace Events in the synthesized invocation trace", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: async context => {
          await emitTraceEvent(context, {
            attributes: { "step.id": "custom-step" },
            name: "agent.custom.step",
            type: "run",
          })
          return "ok"
        }, },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {})).resolves.toBe("ok")

    expect(new Set(traceLog.entries().map(event => event.trace?.id)).size).toBe(1)
    expect(deriveTraceRuns(traceLog.entries())).toHaveLength(1)
  })

  it("records setup failures before invocation start", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => "ok" },
      invoker: {
        resolve: () => {
          throw new Error("setup failed")
        },
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("setup failed")

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.error",
    ])
    expect(traceLog.entries()[0]!.attributes).toMatchObject({
      "agent.invoker.kind": "anonymous",
      "error.message": "setup failed",
    })
  })

  it("preserves resolved invokers in setup failure Trace Events", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "setup",
          resolve() {
            throw new Error("capability setup failed")
          },
        }),
      ],
      driver: { run: () => "ok" },
      invoker: {
        resolve: () => ({ id: "tenant-1", kind: "tenant" }),
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {})).rejects.toThrow("capability setup failed")

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.error",
    ])
    expect(traceLog.entries()[0]!.attributes).toMatchObject({
      "agent.invoker.id": "tenant-1",
      "agent.invoker.kind": "tenant",
      "error.message": "capability setup failed",
    })
  })

  it("exposes resolved Agent Actors alongside legacy invokers", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const prepare = vi.fn()
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [{
        id: "seen",
        prepare({ actor, context, invoker }) {
          prepare({
            actor,
            contextActor: context.get("actor"),
            contextInvoker: context.get("invoker"),
            invoker,
          })
        },
      }],
      hooks: {
        "agent:finish": finish,
      },
      invoker: {
        resolve: () => ({ id: "tenant-1", kind: "tenant", meta: { tier: "pro" } }),
      },
      driver: { run: ({ actor, context, invoker }) => ({
          raw: {
            actor,
            actorIsInvoker: actor === invoker,
            contextActorIsActor: context.get("actor") === actor,
            contextInvokerIsInvoker: context.get("invoker") === invoker,
            invoker,
          },
          text: actor.id,
        }) },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})).resolves.toEqual({
      raw: {
        actor: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
        actorIsInvoker: true,
        contextActorIsActor: true,
        contextInvokerIsInvoker: true,
        invoker: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
      },
      text: "tenant-1",
    })
    expect(prepare).toHaveBeenCalledWith({
      actor: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
      contextActor: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
      contextInvoker: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
      invoker: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
    })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
      invoker: { id: "tenant-1", kind: "tenant", meta: { tier: "pro" } },
    }))
  })

  it("emits stream milestone Trace Events without tracing text deltas", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => (async function* () {
          yield { text: "secret text", type: "text-delta" }
          yield { id: "tool-1", input: { query: "secret" }, name: "search", type: "tool-call" }
          yield { id: "tool-1", name: "search", output: { result: "secret" }, type: "tool-result" }
          yield { type: "usage", usageRecord: { usage: { totalTokens: 3 } } }
          yield { type: "finish" }
        })() },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      trace: { id: "request-1" },
      traceLog,
      waitUntil: vi.fn(),
    }, {})
    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.tool.start",
      "agent.tool.finish",
      "agent.usage.recorded",
      "agent.stream.finish",
      "agent.invocation.finish",
    ])
    expect(new Set(traceLog.entries().map(event => event.attributes?.["agent.run.id"]))).toEqual(new Set(["run-1"]))
    expect(new Set(traceLog.entries().map(event => event.trace?.id))).toEqual(new Set(["request-1"]))
    expect(deriveTraceRuns(traceLog.entries()).map(run => run.id)).toEqual(["run-1"])
    expect(JSON.stringify(traceLog.entries())).not.toContain("secret text")
    expect(JSON.stringify(traceLog.entries())).not.toContain("secret")
  })

  it("derives yielded stream error Trace Events as failed runs", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => (async function* () {
          yield { error: "stream failed", type: "error" }
          yield { type: "finish" }
        })() },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {})
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { error: "stream failed", type: "error" },
      { type: "finish" },
    ])
    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.stream.error",
      "agent.stream.finish",
      "agent.invocation.finish",
    ])
    expect(deriveTraceRuns(traceLog.entries())).toMatchObject([
      { status: "failed" },
    ])
  })

  it("adds safe AI SDK telemetry for traced model-backed agents", async () => {
    const aiGlobal = globalThis as typeof globalThis & { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] }
    const previousGlobalTelemetry = aiGlobal.AI_SDK_TELEMETRY_INTEGRATIONS
    const globalIntegration = { onStart: vi.fn() }
    const agentSettings: Record<string, unknown>[] = []
    aiGlobal.AI_SDK_TELEMETRY_INTEGRATIONS = [globalIntegration]
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        settings: Record<string, unknown>

        constructor(settings: Record<string, unknown>) {
          this.settings = settings
          agentSettings.push(settings)
        }

        async generate() {
          const telemetry = this.settings.telemetry as { integrations: Array<Record<string, (event: unknown) => Promise<void>>> }
          const viteHubTelemetry = telemetry.integrations.at(-1)!
          await viteHubTelemetry.onToolExecutionStart?.({
            toolCall: { toolCallId: "call-1", toolName: "search" },
          })
          await viteHubTelemetry.onToolExecutionEnd?.({
            toolCall: { toolCallId: "call-1", toolName: "search" },
            toolOutput: { error: new Error("lookup failed"), type: "tool-error" },
          })
          return { finishReason: "stop", text: "ok" }
        }

        async stream() {
          return await this.generate()
        }
      },
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const traceLog = createTraceEventLog()
      const agent = defineAgent({       driver: {
        model: {} as never
      },
})

      await expect(runAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        traceLog,
        waitUntil: vi.fn(),
      }, {})).resolves.toMatchObject({ finishReason: "stop", text: "ok" })

      const telemetry = agentSettings[0]!.telemetry as { integrations: unknown[], recordInputs: boolean, recordOutputs: boolean }
      expect(telemetry.integrations[0]).toBe(globalIntegration)
      expect(telemetry.recordInputs).toBe(false)
      expect(telemetry.recordOutputs).toBe(false)
      expect(traceLog.entries().map(event => event.name)).toEqual([
        "agent.invocation.start",
        "agent.tool.start",
        "agent.tool.error",
        "agent.invocation.finish",
      ])
      expect(traceLog.entries().find(event => event.name === "agent.tool.error")?.attributes).toMatchObject({
        "error.message": "lookup failed",
        "step.id": "call-1",
        "tool.id": "call-1",
        "tool.name": "search",
      })
    }
    finally {
      if (previousGlobalTelemetry === undefined) delete aiGlobal.AI_SDK_TELEMETRY_INTEGRATIONS
      else aiGlobal.AI_SDK_TELEMETRY_INTEGRATIONS = previousGlobalTelemetry
      vi.doUnmock("ai")
    }
  })

  it("runs agents with an initial message and structured context", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const run = vi.fn(({ input, messages, run }) => ({
      raw: {
        context: input.context,
        message: getMessageText(messages[0]!),
        runId: run?.runId,
      },
      text: "browser report",
    }))
    const agent = defineAgent({     driver: {
      run
    },
})

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "review-run" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {
      context: { previewUrl: "https://preview.local" },
      message: "Check the product card.",
    })).resolves.toEqual({
      raw: {
        context: expect.objectContaining({ previewUrl: "https://preview.local" }),
        message: "Check the product card.",
        runId: "review-run",
      },
      text: "browser report",
    })
  })

  it("registers subagent tools", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const browserAgent = defineAgent({
      driver: { run: ({ input, invoker, messages, run }) => ({
          raw: {
            context: input.context,
            invokerId: invoker.id,
            message: getMessageText(messages[0]!),
            runId: run?.runId,
          },
          text: "browser report",
        }) },
    })
    const reviewerAgent = defineAgent({
      capabilities: [
        subagents({
          agents: {
            browser: {
              agent: browserAgent,
              description: "Collect browser evidence.",
            },
          },
        }),
      ],
      driver: { async run({ tools }) {
          const tool = tools?.run_browser
          if (!tool?.execute) throw new Error("Missing browser subagent tool.")
          return await tool.execute({
            context: { previewUrl: "https://preview.local" },
            message: "Check the product card.",
          })
        } },
    })

    await expect(runAgent(reviewerAgent, {
      memo: vi.fn(),
      run: { runId: "review-run" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {
      context: {
        invoker: { id: "github:onmax", kind: "github" },
      },
      message: "Review the PR.",
    })).resolves.toEqual({
      raw: {
        context: expect.objectContaining({ previewUrl: "https://preview.local" }),
        invokerId: "github:onmax",
        message: "Check the product card.",
        runId: expect.stringMatching(/^review-run:run_browser:/),
      },
      text: "browser report",
    })
  })

  it("shares named workspace references across subagent runAgent calls", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { registerWorkspaceAgent } = await import("../src/server/workspace.ts")
    const workspaceName = `shared-agent-workspace-${Math.random().toString(36).slice(2)}`
    const summaryAgent = defineAgent({
      workspace: { name: workspaceName, mode: "write" },
      driver: { async run({ workspace }) {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("summary.md", "summary")
          return "summary written"
        } },
    })
    const reviewerAgent = registerWorkspaceAgent(defineAgent({
      workspace: {
        mode: "write",
        store: { provider: "memory" },
      },
      driver: { async run(context) {
          const workspace = context.workspace as WritableWorkspaceFacade
          await workspace.fs.writeFile("review.md", "review")
          await runAgent(summaryAgent, context as never, { message: "write summary" })
          return await workspace.fs.readFile("summary.md")
        } },
    }), { workspace: workspaceName })

    await expect(runAgent(reviewerAgent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { message: "review" })).resolves.toBe("summary")
  })

  it("rejects duplicate generated subagent tool names", async () => {
    const { defineAgent } = await import("../src/index.ts")

    expect(() => subagents({
      agents: {
        "code-review": {
          agent: defineAgent({           driver: {
            run: () => "ok"
          },
}),
          description: "Review code.",
        },
        code_review: {
          agent: defineAgent({           driver: {
            run: () => "ok"
          },
}),
          description: "Review code again.",
        },
      },
    })).toThrow('Duplicate subagent tool name "run_code_review"')
  })

  it("runs subagent tools with the resolved parent runtime context", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const browserAgent = {
      async resolve(context) {
        return {
          async generate({ invoker, runtime }) {
            return {
              raw: {
                invokerId: invoker.id,
                resolveRuntimeConfig: context.runtimeConfig,
                runtimeConfig: runtime.runtimeConfig,
              },
              text: "browser report",
            }
          },
          name: "browser",
        }
      },
    } as ReturnType<typeof defineAgent>
    const reviewerAgent = defineAgent({
      capabilities: [
        subagents({
          agents: {
            browser: {
              agent: browserAgent,
              description: "Collect browser evidence.",
            },
          },
        }),
      ],
      driver: { async run({ tools }) {
          const tool = tools?.run_browser
          if (!tool?.execute) throw new Error("Missing browser subagent tool.")
          return await tool.execute({ message: "Check the product card." })
        } },
    })

    await expect(runAgent(reviewerAgent, {
      memo: vi.fn(),
      run: { runId: "review-run" },
      runtime: "unknown",
      runtimeConfig: { region: "iad" },
      waitUntil: vi.fn(),
    }, {
      context: {
        invoker: { id: "github:onmax", kind: "github" },
      },
      message: "Review the PR.",
    })).resolves.toMatchObject({
      raw: {
        raw: {
          invokerId: "github:onmax",
          resolveRuntimeConfig: { region: "iad" },
          runtimeConfig: { region: "iad" },
        },
      },
      text: "browser report",
    })
  })

  it("runs harness Agent Drivers through AI SDK HarnessAgent", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    harnessAgentSettings.length = 0
    const session = { destroy: vi.fn() }
    const harness = { provider: "codex" }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness,
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    expect(vercelSandboxSettings).toEqual([{ ports: [4000], runtime: "node24" }])
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      harness,
      permissionMode: "allow-all",
      sandboxConfig: {
        onSession: expect.any(Function),
      },
      sandbox: {
        providerId: "vercel",
        settings: { ports: [4000], runtime: "node24" },
      },
    })
    expect(harnessCreateSession).toHaveBeenCalledWith(undefined)
    expect(harnessGenerate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      session,
    }))
    expect(session.destroy).toHaveBeenCalledTimes(1)
  })

  it("avoids Claude Code bypass permissions when the host process runs as root", async () => {
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(0)
    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const session = { destroy: vi.fn() }
      const harness = { harnessId: "claude-code" }
      harnessCreateSession.mockResolvedValueOnce(session)
      harnessGenerate.mockResolvedValueOnce({ text: "ok" })

      const agent = defineAgent({
        driver: {
          harness,
        },
      })

      await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
      expect(harnessAgentSettings.at(-1)).toMatchObject({
        harness,
        permissionMode: "allow-edits",
      })
    }
    finally {
      getuid.mockRestore()
    }
  })

  it("uses harnessSandbox for harness runtime setup", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    const harness = { provider: "codex" }
    const provider = { providerId: "local-test", specificationVersion: "harness-sandbox-v1" }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness,
      },
      harnessSandbox: provider,
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    expect(vercelSandboxSettings).toEqual([])
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      harness,
      sandbox: provider,
    })
    expect((harnessAgentSettings.at(-1)?.tools as Record<string, unknown> | undefined)?.sandbox_exec).toBeUndefined()
  })

  it("resolves function-valued harnessSandbox for each invocation", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    const provider = { providerId: "local-test", runId: "run-1" }
    const harnessSandbox = vi.fn(() => provider)
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
      harnessSandbox,
    })

    await expect(runAgent(agent, { memo: vi.fn(), run: { runId: "run-1" }, runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    expect(harnessSandbox).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ prompt: "hello" }),
      run: { runId: "run-1" },
    }))
    expect(vercelSandboxSettings).toEqual([])
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      sandbox: provider,
    })
  })

  it("uses harnessSandbox on resolved harness adapters", async () => {
    const { defineAgent, resolveAgent } = await import("../src/index.ts")
    const { createAgentInvocationContextStore } = await import("../src/invocation-context.ts")
    const session = { destroy: vi.fn() }
    const provider = { providerId: "local-test", specificationVersion: "harness-sandbox-v1" }
    const harnessSandbox = vi.fn(() => provider)
    const invoker = { id: "anonymous:test", kind: "anonymous", label: "Anonymous" }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
      harnessSandbox,
    })
    const adapter = await resolveAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() })

    await expect(adapter.generate({
      actor: invoker,
      context: createAgentInvocationContextStore(),
      input: { prompt: "hello" },
      invoker,
      messages: [],
      prompt: "hello",
      runtime: { memo: vi.fn(), runtime: "unknown", runtimeConfig: {}, waitUntil: vi.fn() },
    })).resolves.toMatchObject({ text: "ok" })
    expect(harnessSandbox).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ prompt: "hello" }),
    }))
    expect(vercelSandboxSettings).toEqual([])
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      sandbox: provider,
    })
  })

  it("preserves non-text chat history in harness prompts", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    const provider = { provider: "sandbox" }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
      harnessSandbox: provider,
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      context: { chat: {} },
      messages: [
        createMessage({ id: "user-1", role: "user", text: "Remember kiwi-714." }),
        createMessage({
          id: "assistant-1",
          parts: [
            { id: "lookup-1", input: { marker: "kiwi-714" }, name: "lookup", state: "running", type: "tool-call" },
            { id: "lookup-1", name: "lookup", output: { marker: "kiwi-714" }, state: "completed", type: "tool-result" },
            { text: "Tool confirmed marker.", type: "text" },
          ],
          role: "assistant",
        }),
        createMessage({ id: "user-2", parts: [{ data: { scope: "kiwi-714" }, type: "data" }], role: "user" }),
        createMessage({ id: "user-3", parts: [{ error: "prior lookup warning", type: "error" }], role: "user" }),
        createMessage({ id: "user-4", role: "user", text: "What marker?" }),
      ],
    })).resolves.toMatchObject({ text: "ok" })

    expect(vercelSandboxSettings).toEqual([])
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      sandbox: provider,
    })
    expect(harnessGenerate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [
        "Conversation history:",
        "User: Remember kiwi-714.",
        "Assistant: [{\"input\":{\"marker\":\"kiwi-714\"},\"toolCallId\":\"lookup-1\",\"toolName\":\"lookup\",\"type\":\"tool-call\"}]",
        "tool: [{\"output\":{\"type\":\"json\",\"value\":{\"marker\":\"kiwi-714\"}},\"toolCallId\":\"lookup-1\",\"toolName\":\"lookup\",\"type\":\"tool-result\"}]",
        "Assistant: Tool confirmed marker.",
        "User: {\"scope\":\"kiwi-714\"}",
        "User: prior lookup warning",
        "User: What marker?",
        "",
        "Respond to the latest user message.",
      ].join("\n"),
      session,
    }))
  })

  it("resolves function-valued harness Agent Driver config for each invocation", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    harnessAgentSettings.length = 0
    const resolvedHarness = { provider: "codex", runId: "run-1" }
    const harness = vi.fn(() => resolvedHarness)
    const sessionKey = vi.fn(({ context, run }) => {
      const tenant = context.get("tenant") as { id?: string } | undefined
      return `${tenant?.id}:${run?.runId}`
    })
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness,
        sessionKey,
      },
    })

    await expect(runAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {
      context: { tenant: { id: "acme" } },
      prompt: "hello",
    })).resolves.toMatchObject({ text: "ok" })

    expect(harness).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ runId: "run-1" }),
      input: expect.objectContaining({ prompt: "hello" }),
    }))
    expect(sessionKey).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.any(Object),
    }))
    expect(harnessAgentSettings.at(-1)).toMatchObject({
      harness: resolvedHarness,
      sandbox: { providerId: "vercel" },
    })
    expect(harnessCreateSession).toHaveBeenCalledWith({ sessionId: "acme:run-1" })
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

  it("runs lifecycle capabilities around harness Agent Drivers", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { inputCommands, rateLimit, usageTelemetry } = await import("../src/capabilities.ts")
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({
      text: "ok",
      usage: {
        actions: 1,
      },
    })

    const agent = defineAgent({
      capabilities: [
        inputCommands({
          commands: {
            review: {
              description: "Review the request.",
              run: ({ args }) => `Review this: ${args}`,
            },
          },
        }),
        rateLimit({
          id: "harness-lifecycle-rate-limit",
          identity: () => "user_1",
          limit: 5,
          window: "1m",
        }),
        usageTelemetry(),
      ],
      driver: {
        harness: { provider: "codex" },
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "/review checkout" })).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        usage: {
          details: {
            actions: 1,
          },
        },
      },
    })
    expect(harnessGenerate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Review this: checkout",
      session,
    }))
    expect(session.destroy).toHaveBeenCalledOnce()
  })

  it("destroys harness sessions created after abort before running the harness", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const controller = new AbortController()
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockImplementationOnce(async () => {
      controller.abort(new Error("timed out"))
      return session
    })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      abortSignal: controller.signal,
      prompt: "hello",
    })).rejects.toThrow("timed out")
    expect(session.destroy).toHaveBeenCalledOnce()
    expect(harnessGenerate).not.toHaveBeenCalled()
  })

  it("finalizes harness result output before finish hooks", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({
      text: "ok",
      usage: {
        actions: 2,
      },
    })

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ summary: { subject: "Harness run" } }),
        defineCapability({
          id: "harness-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
          },
        }),
      ],
      driver: {
        harness: { provider: "codex" },
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({
      text: "ok\nHarness run reported actions: 2.",
      usageRecord: {
        usage: {
          details: {
            actions: 2,
          },
        },
      },
    })
    expect(finish.mock.calls[0]![0].result).toMatchObject({
      text: "ok\nHarness run reported actions: 2.",
    })
  })

  it("finalizes harness stream output before finish hooks", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessStream.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          type: "finish",
          usage: {
            actions: 3,
          },
        }
      })(),
    })

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ summary: { subject: "Harness stream" } }),
        defineCapability({
          id: "harness-stream-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
          },
        }),
      ],
      driver: {
        harness: { provider: "codex" },
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })
    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          usage: {
            details: {
              actions: 3,
            },
          },
        }),
      },
      { type: "finish" },
    ])
    expect(finish.mock.calls[0]![0].result).toMatchObject({
      text: "ok\nHarness stream reported actions: 3.",
    })
  })

  it("keeps harness UI message streams readable after session cleanup wrapping", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    const toUIMessageStreamMock = vi.fn(() => new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ messageId: "msg-1", type: "start" })
        controller.enqueue({ data: { source: "harness" }, id: "native-data", type: "data" })
        controller.enqueue({ id: "msg-1", type: "text-start" })
        controller.enqueue({ delta: "native", id: "msg-1", type: "text-delta" })
        controller.enqueue({ id: "msg-1", type: "text-end" })
        controller.enqueue({ finishReason: "stop", type: "finish" })
        controller.close()
      },
    }))
    harnessStream.mockResolvedValueOnce({
      stream: (async function* () {
        yield { messageId: "msg-1", type: "start" }
        yield { id: "msg-1", type: "text-start" }
        yield { delta: "ok", id: "msg-1", type: "text-delta" }
        yield { id: "msg-1", type: "text-end" }
        yield { finishReason: "stop", type: "finish" }
      })(),
      toUIMessageStream: toUIMessageStreamMock,
    })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
    })

    const stream = await streamAgent(
      agent,
      { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() },
      { prompt: "hello" },
      { output: "ui-message-stream" },
    ) as ReadableStream<unknown>
    const chunks: unknown[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    expect(chunks).toContainEqual({ data: { source: "harness" }, id: "native-data", type: "data" })
    expect(chunks).toContainEqual({ delta: "native", id: "msg-1", type: "text-delta" })
    expect(toUIMessageStreamMock).toHaveBeenCalledOnce()
    expect(session.destroy).toHaveBeenCalledOnce()
  })

  it("preserves aliased harness stream surfaces during session cleanup wrapping", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    const nativeStream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ messageId: "msg-1", type: "start" })
        controller.enqueue({ id: "msg-1", type: "text-start" })
        controller.enqueue({ delta: "native", id: "msg-1", type: "text-delta" })
        controller.enqueue({ id: "msg-1", type: "text-end" })
        controller.enqueue({ finishReason: "stop", type: "finish" })
        controller.close()
      },
    })
    const toUIMessageStreamMock = vi.fn(function (this: { fullStream: unknown, stream: unknown }) {
      expect(this.stream).toBe(this.fullStream)
      return this.stream
    })
    harnessStream.mockResolvedValueOnce({
      fullStream: nativeStream,
      stream: nativeStream,
      toUIMessageStream: toUIMessageStreamMock,
    })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
      harnessSandbox: { provider: "sandbox" },
    })

    const stream = await streamAgent(
      agent,
      { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() },
      { prompt: "hello" },
      { output: "ui-message-stream" },
    ) as ReadableStream<unknown>
    const chunks: unknown[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    expect(chunks).toContainEqual({ delta: "native", id: "msg-1", type: "text-delta" })
    expect(toUIMessageStreamMock).toHaveBeenCalledOnce()
    expect(session.destroy).toHaveBeenCalledOnce()
  })

  it("keeps aliased harness UI message streams readable with usage telemetry", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const session = { destroy: vi.fn() }
    const onUsage = vi.fn()
    harnessCreateSession.mockResolvedValueOnce(session)
    const nativeStream = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ messageId: "msg-1", type: "start" })
        controller.enqueue({ id: "msg-1", type: "text-start" })
        controller.enqueue({ delta: "native", id: "msg-1", type: "text-delta" })
        controller.enqueue({ id: "msg-1", type: "text-end" })
        controller.enqueue({
          finishReason: "stop",
          totalUsage: {
            inputTokens: 1,
            outputTokens: 2,
          },
          type: "finish",
        })
        controller.close()
      },
    })
    const toUIMessageStreamMock = vi.fn(function (this: { stream: ReadableStream<unknown> }) {
      return this.stream
    })
    harnessStream.mockResolvedValueOnce({
      fullStream: nativeStream,
      stream: nativeStream,
      toUIMessageStream: toUIMessageStreamMock,
    })

    const agent = defineAgent({
      capabilities: [usageTelemetry({ onUsage })],
      driver: {
        harness: { provider: "codex" },
      },
      harnessSandbox: { provider: "sandbox" },
    })

    const stream = await streamAgent(
      agent,
      { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() },
      { prompt: "hello" },
      { output: "ui-message-stream" },
    ) as ReadableStream<unknown>
    const chunks: unknown[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    expect(chunks).toContainEqual({ delta: "native", id: "msg-1", type: "text-delta" })
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    }), expect.anything())
    expect(toUIMessageStreamMock).toHaveBeenCalledOnce()
    expect(session.destroy).toHaveBeenCalledOnce()
  })

  it("converts harness text streams with native UI streams after session cleanup wrapping", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessStream.mockResolvedValueOnce({
      textStream: (async function* () {
        yield "hel"
        yield "lo"
      })(),
      toUIMessageStream() {
        throw new Error("native UI stream should not be used for event iteration")
      },
    })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })
    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "hel", type: "text-delta" },
      { text: "lo", type: "text-delta" },
      { type: "finish" },
    ])
    expect(session.destroy).toHaveBeenCalledOnce()
  })

  it("passes model-facing Capability tools into harness Agent Drivers", async () => {
    const { defineCapability } = await import("../src/capability-runtime.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const session = { destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(session)
    harnessGenerate.mockResolvedValueOnce({ text: "ok" })

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "model-tools",
          tools: () => ({
            lookup: {
              name: "lookup",
              execute: async () => "ok",
            },
          }),
        }),
      ],
      driver: {
        harness: { provider: "codex" },
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    expect(harnessAgentSettings).toHaveLength(1)
    expect(harnessAgentSettings.at(-1)?.tools).toHaveProperty("lookup")
    expect(harnessCreateSession).toHaveBeenCalledWith(undefined)
    expect(harnessGenerate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      session,
    }))
  })

  it("does not resolve static Capability tools for harness Agent Drivers", async () => {
    const { defineCapability } = await import("../src/capability-runtime.ts")
    const { defineAgent, resolveAgent } = await import("../src/index.ts")
    const resolveTools = vi.fn(() => ({
      lookup: {
        name: "lookup",
        execute: async () => "ok",
      },
    }))

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "model-tools",
          tools: resolveTools,
        }),
      ],
      driver: {
        harness: { provider: "codex" },
      },
    })

    await expect(resolveAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() })).resolves.toMatchObject({
      name: "ai-sdk-harness",
    })
    expect(resolveTools).not.toHaveBeenCalled()
  })

  it("rejects provider tools before harness execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { webSearch } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [webSearch({ mode: "model" })],
      driver: {
        harness: { provider: "codex" },
      },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "hello" }))
      .rejects.toThrow("web-search: provider tools")
    expect(harnessAgentSettings).toHaveLength(0)
    expect(harnessCreateSession).not.toHaveBeenCalled()
    expect(harnessGenerate).not.toHaveBeenCalled()
  })

  it("rejects capability config prose before harness execution", async () => {
    const { defineCapability } = await import("../src/capability-runtime.ts")

    expect(() => defineCapability({
      id: "model-instructions",
      instructions: "Use model-only context." as never,
    } as never)).toThrow("Capability instructions were removed")
    expect(harnessCreateSession).not.toHaveBeenCalled()
    expect(harnessGenerate).not.toHaveBeenCalled()
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
        sessionKey: "thread-1",
      },
    })

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      context: { chat: {} },
      messages: [
        createMessage({ id: "user-1", role: "user", text: "hello" }),
        createMessage({ id: "assistant-1", role: "assistant", text: "ok" }),
        createMessage({ id: "user-2", role: "user", text: "again" }),
      ],
    })
    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      context: { chat: {} },
      messages: [
        createMessage({ id: "user-1", role: "user", text: "hello" }),
        createMessage({ id: "assistant-1", role: "assistant", text: "ok" }),
        createMessage({ id: "user-2", role: "user", text: "again" }),
      ],
    })

    expect(harnessCreateSession).toHaveBeenNthCalledWith(1, { sessionId: "thread-1" })
    expect(harnessCreateSession).toHaveBeenNthCalledWith(2, { resumeFrom: { token: "resume" }, sessionId: "thread-1" })
    expect(harnessGenerate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: [
        "Conversation history:",
        "User: hello",
        "Assistant: ok",
        "User: again",
        "",
        "Respond to the latest user message.",
      ].join("\n"),
      session: firstSession,
    }))
    expect(harnessGenerate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: [
        "Conversation history:",
        "User: again",
        "",
        "Respond to the latest user message.",
      ].join("\n"),
      session: secondSession,
    }))
    expect(firstSession.detach).toHaveBeenCalledTimes(1)
    expect(secondSession.detach).toHaveBeenCalledTimes(1)
  })

  it("treats undefined harness detach state as a resumed session", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const firstSession = { detach: vi.fn(async () => undefined), destroy: vi.fn() }
    const secondSession = { detach: vi.fn(async () => undefined), destroy: vi.fn() }
    harnessCreateSession.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession)
    harnessGenerate.mockResolvedValue({ text: "ok" })

    const agent = defineAgent({
      driver: {
        harness: { provider: "codex" },
        sessionKey: "thread-1",
      },
      harnessSandbox: { provider: "sandbox" },
    })
    const input = {
      context: { chat: {} },
      messages: [
        createMessage({ id: "user-1", role: "user", text: "hello" }),
        createMessage({ id: "assistant-1", role: "assistant", text: "ok" }),
        createMessage({ id: "user-2", role: "user", text: "again" }),
      ],
    }

    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, input)
    await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, input)

    expect(harnessCreateSession).toHaveBeenNthCalledWith(1, { sessionId: "thread-1" })
    expect(harnessCreateSession).toHaveBeenNthCalledWith(2, { sessionId: "thread-1" })
    expect(harnessGenerate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt: [
        "Conversation history:",
        "User: again",
        "",
        "Respond to the latest user message.",
      ].join("\n"),
      session: secondSession,
    }))
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
    } as never)).toThrow("does not expose harness permissions")

    expect(() => defineAgent({
      driver: { harness: { provider: "codex" }, permissionMode: "ask" },
    } as never)).toThrow("does not expose harness permissions")

    expect(() => defineAgent({
      driver: { credentials: { value: "secret" }, harness: { provider: "codex" } },
    } as never)).toThrow("driver.credentials.value")

    expect(() => defineAgent({
      driver: { harness: { provider: "codex" }, instructions: "ignored" },
    } as never)).toThrow("does not support option: instructions")

    expect(() => defineAgent({
      driver: { harness: { provider: "codex" }, sandbox: { provider: "sandbox" } },
    } as never)).toThrow("does not support option: sandbox")

    expect(() => defineAgent({
      driver: { model: {} as never, sandbox: { provider: "sandbox" } },
    } as never)).toThrow("does not support option: sandbox")

    expect(() => defineAgent({
      driver: { execution: {}, run: () => "ok" },
    } as never)).toThrow("does not support option: execution")

    expect(() => defineAgent({
      driver: { instructions: "ignored", run: () => "ok" },
    } as never)).toThrow("does not support option: instructions")
  })

  it("creates inline schedule capabilities without requiring chat history", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      capabilities: [schedule({ schedules: ["0   9 * * *", { cron: "15 10 * * 1-5", id: "weekday-digest" }] })],
      driver: { run: () => "ok" },
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
      driver: { run: context => {
          seen.push({ input: context.input, messages: context.messages })
          return "ok"
        } },
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
      driver: { run: context => {
          seen.push(context.input)
          return "ok"
        } },
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
      driver: { run: context => [
          context.memo("resource", create),
          context.memo("resource", create),
        ] },
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
      driver: { run: context => {
          seen.push({
            run: context.run,
            runtime: context.runtime,
            waitUntil: context.waitUntil,
          })
          return "ok"
        } },
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

  it("converts structured tool history to JSON-compatible model messages", async () => {
    const { toAiSdkModelMessages } = await import("../src/ai-sdk.ts")

    const messages = [
      {
        id: "m1",
        parts: [
          { id: "call-1", name: "lookup", output: { timestamp: new Date("2026-06-22T19:30:00.000Z") }, state: "completed", type: "tool-result" },
        ],
        role: "tool",
      },
    ] as unknown as Parameters<typeof toAiSdkModelMessages>[0]

    expect(toAiSdkModelMessages(messages)).toEqual([
      {
        content: [{ output: { type: "json", value: { timestamp: "2026-06-22T19:30:00.000Z" } }, toolCallId: "call-1", toolName: "lookup", type: "tool-result" }],
        role: "tool",
      },
    ])
  })

  it("converts live tool execution results to JSON-compatible values", async () => {
    const { withJsonCompatibleToolOutputs } = await import("../src/tool-runtime.ts")

    const tools = withJsonCompatibleToolOutputs({
      lookup: {
        execute: (_input: unknown) => ({ timestamp: new Date("2026-06-22T19:30:00.000Z") }),
        name: "lookup",
      },
    })

    await expect(tools.lookup.execute?.({})).resolves.toEqual({
      timestamp: "2026-06-22T19:30:00.000Z",
    })
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
      driver: { run: context => `received ${context.prompt}` },
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

  it("does not export entry() from capabilities", async () => {
    const capabilities = await import("../src/capabilities.ts")

    expect("entry" in capabilities).toBe(false)
  })

  it("creates custom trigger channels with defineChannel()", async () => {
    const { defineAgent, resolveAgentTriggers, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const agent = defineAgent({
      channels: {
        portal: defineChannel("portal", {
          messages: false,
          triggers: {
            message: {
              invoke: (context, input: { text: string }) => ({
                input: {
                  context: { channelKind: context.channel.kind },
                  messages: [createMessage({ role: "user", text: input.text })],
                },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      driver: { run: (context) => {
          const trigger = context.context.get<{ source?: string }>("agent.trigger")
          return `${trigger?.source}:${context.context.get("channelKind")}:${getMessageText(context.messages[0]!)}`
        } },
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(resolveAgentTriggers(agent, runtime)).resolves.toMatchObject({
      "portal.message": {
        channelId: "portal",
        id: "portal.message",
        name: "message",
        source: "channel",
      },
    })
    await expect(runAgentTrigger(agent, runtime, "portal.message", { text: "hello" })).resolves.toBe("channel:portal:hello")
  })

  it("lets Channels execute Capability-contributed delivery effect intents", async () => {
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const order: string[] = []
    const effect = vi.fn((context) => {
      order.push(`effect:${context.effect.kind}:${context.effect.intent}`)
      expect(context.trigger).toMatchObject({ channelId: "portal", id: "portal.message", name: "message" })
      expect(context.run).toMatchObject({ channelId: "portal", runId: "portal-run" })
    })
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "feedback",
          prepare(context) {
            context.delivery.effect({ intent: "started", kind: "reaction" })
          },
        }),
      ],
      channels: {
        portal: defineChannel("portal", {
          effects: { reaction: effect },
          messages: false,
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      driver: { run: () => {
          order.push("run")
          return "ok"
        } },
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(runAgentTrigger(agent, runtime, "portal.message", {})).resolves.toBe("ok")
    expect(effect).toHaveBeenCalledOnce()
    expect(order).toEqual(["effect:reaction:started", "run"])
  })

  it("lets Channel triggers expose finish delivery effects", async () => {
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const order: string[] = []
    const effect = vi.fn((context) => {
      order.push(`effect:${context.effect.payload}`)
      expect(context.finish?.result).toBe("ok")
      expect(context.finish?.extensions.get("marker")).toEqual({ value: "done" })
    })
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "marker",
          output(context) {
            context.finish.provide({ value: "done" })
          },
        }),
      ],
      channels: {
        portal: defineChannel("portal", {
          effects: { reply: effect },
          messages: false,
          triggers: {
            message: {
              invoke: context => ({
                delivery: {
                  finishEffects: event => ({
                    kind: "reply",
                    payload: `result:${event.result}:${(event.extensions.get("marker") as { value?: string } | undefined)?.value}`,
                  }),
                },
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      driver: { run: () => {
          order.push("run")
          return "ok"
        } },
    })

    await expect(runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "portal.message", {})).resolves.toBe("ok")
    expect(effect).toHaveBeenCalledOnce()
    expect(order).toEqual(["run", "effect:result:ok:done"])
  })

  it("lets finish delivery effects publish Workspace artifacts", async () => {
    const { defineAgent, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel, publishWorkspaceArtifacts } = await import("../src/channels.ts")
    const content = new Uint8Array([1, 2, 3])
    const publish = vi.fn(async () => ({ url: "https://assets.example/review/screenshots/result.png" }))
    const effect = vi.fn((context) => {
      expect(context.effect).toMatchObject({
        artifacts: [{
          path: "screenshots/result.png",
          url: "https://assets.example/review/screenshots/result.png",
        }],
        kind: "reply",
        payload: "done",
      })
    })
    const agent = defineAgent({
      channels: {
        portal: defineChannel("portal", {
          effects: { reply: effect },
          messages: false,
          triggers: {
            message: {
              invoke: context => ({
                delivery: {
                  finishEffects: async (_event, finishContext) => ({
                    artifacts: await publishWorkspaceArtifacts(finishContext, [{
                      mediaType: "image/png",
                      path: "screenshots/result.png",
                      placement: "inline",
                    }], {
                      prefix: "review",
                      publish,
                    }),
                    kind: "reply",
                    payload: "done",
                  }),
                },
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      driver: { run: async ({ workspace }) => {
          await (workspace as WritableWorkspaceFacade).fs.writeFile("screenshots/result.png", content, { mediaType: "image/png" })
          return "ok"
        } },
      workspace: { mode: "write", store: { provider: "memory" } },
    })

    await expect(runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "portal.message", {})).resolves.toBe("ok")
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      content,
      mediaType: "image/png",
      pathname: "review/screenshots/result.png",
    }))
    expect(effect).toHaveBeenCalledOnce()
  })

  it("lets Capabilities expose finish delivery effects", async () => {
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const effect = vi.fn((context) => {
      expect(context.effect).toMatchObject({ kind: "reply", payload: "done:ok" })
      expect(context.finish?.result).toBe("ok")
    })
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "feedback",
          prepare(context) {
            context.delivery.finishEffect(event => ({ kind: "reply", payload: `done:${event.result}` }))
          },
        }),
      ],
      channels: {
        portal: defineChannel("portal", {
          effects: { reply: effect },
          messages: false,
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      driver: { run: () => "ok" },
    })

    await expect(runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "portal.message", {})).resolves.toBe("ok")
    expect(effect).toHaveBeenCalledOnce()
  })

  it("ignores unsupported delivery effect intents with observer metadata", async () => {
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const observe = vi.fn()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "feedback",
          prepare(context) {
            context.delivery.effect({ intent: "started", kind: "reaction" })
          },
        }),
      ],
      channels: {
        portal: defineChannel("portal", {
          messages: false,
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      hooks: {
        "hook:observe": observe,
      },
      driver: { run: () => "ok" },
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    await expect(runAgentTrigger(agent, runtime, "portal.message", {})).resolves.toBe("ok")
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        "channel.effect.kind": "reaction",
        "channel.effect.supported": false,
      }),
      name: "channel:delivery-effect",
      outcome: "success",
      owner: "channel",
    }))
  })

  it("does not fail invocations when delivery effects or hook observers fail", async () => {
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "feedback",
          prepare(context) {
            context.delivery.effect({ intent: "started", kind: "reaction" })
          },
        }),
      ],
      channels: {
        portal: defineChannel("portal", {
          effects: {
            reaction: () => {
              throw new Error("reaction failed")
            },
          },
          messages: false,
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run" },
              }),
            },
          },
        }),
      },
      hooks: {
        "hook:observe": () => {
          throw new Error("observer failed")
        },
      },
      driver: { run: () => "ok" },
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    try {
      await expect(runAgentTrigger(agent, runtime, "portal.message", {})).resolves.toBe("ok")
      expect(warn).toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it("exposes Agent Trigger metadata", async () => {
    const { defineChannel } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = {
      channels: {
        github: defineChannel("github", {
          messages: false,
          triggers: {
            webhook: {
              invoke: (_context, input: { body: string, deliveryId: string }) => ({
                input: { prompt: input.body },
                run: { origin: "github", runId: input.deliveryId },
              }),
            },
          },
        }),
      },
      resolve: vi.fn(),
    }

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "github.webhook": {
        channelId: "github",
        source: "channel",
      },
    })
  })

  it("exposes Capability Trigger metadata", async () => {
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = {
      capabilities: [{
        id: "custom",
        triggers: {
          ping: {
            invoke: (_context: unknown, input: { body: string, deliveryId: string }) => ({
              input: { prompt: input.body },
              run: { origin: "custom", runId: input.deliveryId },
            }),
          },
        },
      }],
      resolve: vi.fn(),
    }

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "custom.ping": {
        capabilityId: "custom",
        source: "capability",
      },
    })
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
        sessions: true,
        triggerHistory: { maxMessages: 20, source: "thread" },
      },
      driver: { run: () => "ok" },
    })

    expect(agent.chat).toMatchObject({
      concurrency: "queue",
      sessions: true,
      triggerHistory: { maxMessages: 20, source: "thread" },
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

  it("creates Telegram message channels with Telegram webhook defaults", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { telegram } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const adapter = () => ({}) as never
    const agent = defineAgent({
      channels: {
        telegram: telegram({
          adapter,
          webhooks: {
            path: "/api/telegram/support",
            secretToken: "secret-token",
          },
        }),
      },
      driver: { run: () => "ok" },
    })

    expect(agent.chat?.platforms).toEqual({ telegram: adapter })
    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: [{
          id: "telegram",
          method: "POST",
          path: "/api/telegram/support",
          provider: "telegram",
          secretHeader: "x-telegram-bot-api-secret-token",
          secretToken: "secret-token",
        }],
      },
    })
  })

  it("adds GitHub webhook defaults to delivery triggers", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      channels: {
        github: github({
          app: { webhookSecret: "secret-token" },
          triggers: {
            webhook: {
              invoke: () => ({ input: { prompt: "github" } }),
            },
          },
          webhooks: { path: "/api/github/webhook" },
        }),
      },
      driver: { run: () => "ok" },
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "github.webhook": {
        channelId: "github",
        source: "channel",
        webhooks: [{
          channelId: "github",
          id: "github",
          method: "POST",
          path: "/api/github/webhook",
          provider: "github",
          secretHeader: "x-hub-signature-256",
          secretToken: "secret-token",
          signature: "github-sha256",
        }],
      },
    })
  })

  it("attaches GitHub webhook defaults to pull request comment events", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      channels: {
        github: github({
          app: { webhookSecret: "secret-token" },
          events: { pullRequestComments: true },
          webhooks: { path: "/api/github/webhook" },
        }),
      },
      driver: { run: () => "ok" },
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "github.webhook": {
        channelId: "github",
        source: "channel",
        webhooks: [{
          channelId: "github",
          id: "github",
          method: "POST",
          path: "/api/github/webhook",
          provider: "github",
          secretHeader: "x-hub-signature-256",
          secretToken: "secret-token",
          signature: "github-sha256",
        }],
      },
    })
  })

  it("keeps GitHub events on the channel trigger", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { github } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      channels: {
        github: github({
          events: {
            pullRequestComments: true,
          },
        }),
      },
      driver: { run: () => "ok" },
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "github.webhook": {
        channelId: "github",
        source: "channel",
      },
    })
  })

  it("feeds GitHub PR comment commands through input commands and write-back effects", async () => {
    const { defineAgent, defineCapability, runAgentTrigger } = await import("../src/index.ts")
    const { inputCommands, usageTelemetry } = await import("../src/capabilities.ts")
    const { github } = await import("../src/channels.ts")
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url)
      if (href.endsWith("/app/installations/123/access_tokens")) {
        return Response.json({ expires_at: new Date(Date.now() + 600_000).toISOString(), token: "installation-token" })
      }
      if (href.endsWith("/pulls/42")) {
        return Response.json({ head: { sha: "abc123" } })
      }
      if (href.endsWith("/issues/comments/99/reactions") && init?.method === "POST") {
        return Response.json({ id: 777 }, { status: 201 })
      }
      return Response.json({ ok: true }, { status: init?.method === "POST" ? 201 : 200 })
    })
    const input = {
      github: { deliveryId: "delivery-1", event: "issue_comment", installationId: 123 },
      payload: {
        action: "created",
        comment: {
          author_association: "MEMBER",
          body: "/review please",
          created_at: "2026-06-19T10:00:00Z",
          html_url: "https://github.test/vite-hub/vitehub/pull/42#issuecomment-99",
          id: 99,
          node_id: "comment-node",
          updated_at: "2026-06-19T10:01:00Z",
          user: { id: 1, login: "onmax", type: "User" },
        },
        issue: {
          html_url: "https://github.test/vite-hub/vitehub/pull/42",
          labels: [{ name: "agent" }],
          number: 42,
          pull_request: {
            html_url: "https://github.test/vite-hub/vitehub/pull/42",
            url: "https://api.github.test/repos/vite-hub/vitehub/pulls/42",
          },
          title: "Improve review commands",
        },
        repository: {
          full_name: "vite-hub/vitehub",
          name: "vitehub",
          owner: { login: "vite-hub" },
        },
        sender: { id: 1, login: "onmax", type: "User" },
      },
    }
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "review-feedback",
        prepare(context) {
          context.delivery.effect({ intent: "completed", kind: "status", metadata: { description: "Review completed." } })
        },
      }), inputCommands({
        commands: {
          review: {
            description: "Review a pull request.",
            call({ input }) {
              const command = input.context?.github as Record<string, unknown> | undefined
              const pullRequest = input.context?.pullRequest as Record<string, unknown> | undefined
              if (!command || !pullRequest) throw new Error("Missing GitHub pull request context.")
              expect(command.actor).toMatchObject({ association: "MEMBER" })
              expect(pullRequest).toMatchObject({
                pullRequest: {
                  htmlUrl: "https://github.test/vite-hub/vitehub/pull/42",
                  labels: ["agent"],
                  number: 42,
                  source: {
                    mount: "vitehub",
                    ref: "refs/pull/42/head",
                    repo: "vite-hub/vitehub",
                  },
                  title: "Improve review commands",
                },
                run: {
                  messageId: "99",
                  origin: "github-review",
                  runId: "delivery-1",
                  threadId: "https://github.test/vite-hub/vitehub/pull/42",
                },
                trigger: {
                  comment: {
                    body: "/review please",
                    htmlUrl: "https://github.test/vite-hub/vitehub/pull/42#issuecomment-99",
                  },
                  event: "issue_comment",
                  sender: { login: "onmax" },
                },
              })
            },
            hooks: {
              async "agent:input"(context) {
                await context.message.react("eyes", { transient: true })
                await context.message.reply("Review queued.")
              },
            },
          },
        },
      }), usageTelemetry({ summary: { subject: "Review run" } })],
      channels: {
        github: github({
          app: {
            apiBaseUrl: "https://api.github.test",
            appId: "1",
            fetch: fetcher as typeof fetch,
            installationId: 123,
            privateKey: privateKeyPem,
            statusContext: "ViteHub Review",
          },
          events: {
            pullRequestComments: {
              origin: "github-review",
            },
          },
        }),
      },
      driver: { run: (context) => {
          expect(context.prompt).toBe("")
          return {
            text: "Review completed.",
            totalUsage: { inputTokens: 10, outputTokens: 5 },
          }
        } },
    })

    await expect(runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "github.webhook", input)).resolves.toMatchObject({
      text: "Review completed.",
    })

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/app/installations/123/access_tokens",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: expect.stringMatching(/^Bearer [^.]+\.[^.]+\.[^.]+$/) }),
        method: "POST",
      }),
    )
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/issues/comments/99/reactions",
      expect.objectContaining({
        body: JSON.stringify({ content: "eyes" }),
        headers: expect.objectContaining({ authorization: "Bearer installation-token" }),
        method: "POST",
      }),
    )
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/issues/comments/99/reactions/777",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer installation-token" }),
        method: "DELETE",
      }),
    )
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/issues/42/comments",
      expect.objectContaining({
        body: JSON.stringify({ body: "Review queued." }),
        method: "POST",
      }),
    )
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/issues/42/comments",
      expect.objectContaining({
        body: expect.stringContaining("\"body\":\"Review completed.\\n\\n> [!NOTE]\\n> Review run used 15 tokens: 10 in / 5 out"),
        method: "POST",
      }),
    )
    expect(fetcher).toHaveBeenCalledWith("https://api.github.test/repos/vite-hub/vitehub/pulls/42", expect.objectContaining({ method: "GET" }))
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.test/repos/vite-hub/vitehub/statuses/abc123",
      expect.objectContaining({
        body: JSON.stringify({
          context: "ViteHub Review",
          description: "Review completed.",
          state: "success",
        }),
        method: "POST",
      }),
    )
  })

  it("handles unauthorized GitHub PR comment commands without running the agent", async () => {
    const { defineAgent, runAgentTrigger } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const { github } = await import("../src/channels.ts")
    const commandRun = vi.fn(({ input }) => {
      const pullRequest = input.context?.pullRequest as { trigger?: { actor?: { association?: string } } } | undefined
      return pullRequest?.trigger?.actor?.association === "MEMBER"
        ? { prompt: "unexpected" }
        : Response.json({ accepted: false, ok: true, reason: "unauthorized" })
    })
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      capabilities: [inputCommands({
        commands: {
          review: {
            description: "Review a pull request.",
            run: commandRun,
          },
        },
      })],
      channels: {
        github: github({
          app: { webhookSecret: false },
          events: { pullRequestComments: true },
        }),
      },
      driver: {
        run
      },
    })
    const input = {
      github: { deliveryId: "delivery-unauthorized", event: "issue_comment", installationId: 123 },
      payload: {
        action: "created",
        comment: {
          author_association: "CONTRIBUTOR",
          body: "/review please",
          id: 100,
          user: { login: "contributor", type: "User" },
        },
        issue: {
          number: 42,
          pull_request: { url: "https://api.github.test/repos/vite-hub/vitehub/pulls/42" },
        },
        repository: {
          full_name: "vite-hub/vitehub",
          name: "vitehub",
          owner: { login: "vite-hub" },
        },
      },
    }

    const response = await runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "github.webhook", input)

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(200)
    await expect((response as Response).json()).resolves.toEqual({ accepted: false, ok: true, reason: "unauthorized" })
    expect(commandRun).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })

  it("ignores unsupported GitHub PR comment commands without running the agent", async () => {
    const { defineAgent, runAgentTrigger } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const { github } = await import("../src/channels.ts")
    const summaryRun = vi.fn(() => "unexpected")
    const run = vi.fn(() => "unexpected")
    const agent = defineAgent({
      capabilities: [inputCommands({
        commands: {
          summary: {
            description: "Summarize a pull request.",
            run: summaryRun,
          },
        },
      })],
      channels: {
        github: github({
          app: { webhookSecret: false },
          events: { pullRequestComments: true },
        }),
      },
      driver: {
        run
      },
    })

    const response = await runAgentTrigger(agent, { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }, "github.webhook", {
      github: { deliveryId: "delivery-unsupported", event: "issue_comment" },
      payload: {
        action: "created",
        comment: {
          body: "/review please",
          id: 101,
          user: { login: "contributor", type: "User" },
        },
        issue: {
          number: 42,
          pull_request: { url: "https://api.github.test/repos/vite-hub/vitehub/pulls/42" },
        },
        repository: {
          full_name: "vite-hub/vitehub",
          name: "vitehub",
          owner: { login: "vite-hub" },
        },
      },
    })

    expect(response).toBeInstanceOf(Response)
    await expect((response as Response).json()).resolves.toEqual({ accepted: false, ok: true, reason: "not_command" })
    expect(summaryRun).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("filters GitHub PR comment input commands by configured channel id", async () => {
    const { defineAgent, runAgentTrigger } = await import("../src/index.ts")
    const { inputCommands } = await import("../src/capabilities.ts")
    const { github } = await import("../src/channels.ts")
    const calls: string[] = []
    const agent = defineAgent({
      capabilities: [inputCommands({
        commands: {
          review: {
            channels: ["github"],
            description: "Review a pull request.",
            call: ({ args }) => {
              calls.push(`review:${args}`)
              return args
            },
          },
          summary: {
            description: "Summarize a pull request.",
            call: ({ args }) => {
              calls.push(`summary:${args}`)
              return args
            },
          },
        },
      })],
      channels: {
        github: github({
          app: { webhookSecret: false },
          events: { pullRequestComments: true },
        }),
        triage: github({
          app: { webhookSecret: false },
          events: { pullRequestComments: true },
        }),
      },
      driver: { run: context => `ran:${context.prompt}` },
    })
    const delivery = (body: string, id: number) => ({
      github: { deliveryId: `delivery-${id}`, event: "issue_comment" },
      payload: {
        action: "created",
        comment: {
          body,
          id,
          user: { login: "contributor", type: "User" },
        },
        issue: {
          number: 42,
          pull_request: { url: "https://api.github.test/repos/vite-hub/vitehub/pulls/42" },
        },
        repository: {
          full_name: "vite-hub/vitehub",
          name: "vitehub",
          owner: { login: "vite-hub" },
        },
      },
    })
    const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn() }

    const filtered = await runAgentTrigger(agent, runtime, "triage.webhook", delivery("/review please", 201))
    expect(filtered).toBeInstanceOf(Response)
    await expect((filtered as Response).json()).resolves.toEqual({ accepted: false, ok: true, reason: "not_command" })

    await expect(runAgentTrigger(agent, runtime, "triage.webhook", delivery("/summary please", 202))).resolves.toBe("ran:please")
    await expect(runAgentTrigger(agent, runtime, "github.webhook", delivery("/review please", 203))).resolves.toBe("ran:please")
    expect(calls).toEqual(["summary:please", "review:please"])
  })

  it("keeps channel chat triggers discoverable for workspace agents", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")
    const { resolveAgentTriggers } = await import("../src/trigger-runtime.ts")
    const agent = defineAgent({
      capabilities: [{ id: "custom" }],
      channels: { web: webChat() },
      driver: { run: () => "ok" },
      workspace: {},
    })
    const registered = withAgentDefaults(agent as never, { workspace: "docs" })

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
          adapter: () => ({}) as never,
          webhooks: [
            { path: "/api/support/primary" },
            { path: "/api/support/fallback" },
          ],
        }),
      },
      driver: { run: () => "ok" },
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
      driver: { run: () => "ok" },
    })

    await expect(resolveAgentTriggers(agent, { memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() })).resolves.toMatchObject({
      "chat.message": {
        webhooks: undefined,
      },
    })
  })

  it("rejects unwired HTTP channel paths", async () => {
    const { http } = await import("../src/channels.ts")

    expect(() => http({ path: "/api/support/chat" } as never)).toThrow("[vitehub] http({ path }) is not wired yet.")
  })

  it("rejects channel webhooks without an adapter", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { http } = await import("../src/channels.ts")

    expect(() => defineAgent({
      channels: {
        support: http({
          webhooks: { path: "/api/support/chat" },
        }),
      },
      driver: { run: () => "ok" },
    })).toThrow("[vitehub] Channel webhooks require an adapter-backed Channel.")
  })

  it("rejects legacy message history settings", async () => {
    const { chat } = await import("../src/capabilities.ts")
    const { defineAgent } = await import("../src/index.ts")
    const { webChat } = await import("../src/channels.ts")

    expect(() => chat({
      history: { maxMessages: 20, source: "thread" },
    })).toThrow("messages.history was replaced by messages.triggerHistory")

    expect(() => defineAgent({
      channels: {
        web: webChat(),
      },
      messages: {
        history: { maxMessages: 20, source: "thread" },
      },
      driver: { run: () => "ok" },
    })).toThrow("messages.history was replaced by messages.triggerHistory")
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
      driver: { run: () => "ok" },
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
            sessions: false,
            triggerHistory: "none",
          },
        }),
      },
      driver: { run: () => "ok" },
    })

    expect(agent.chat).toMatchObject({
      sessions: false,
      triggerHistory: "none",
    })
  })

  it("rejects channel-local message settings across multiple message-shaped channels", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { teams, webChat } = await import("../src/channels.ts")

    expect(() => defineAgent({
      channels: {
        teams: teams({ adapter: () => ({}) as never }),
        web: webChat({ messages: { triggerHistory: "none" } }),
      },
      driver: { run: () => "ok" },
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
      driver: { run: () => "ok" },
    })).toThrow("Channel-local identity resolvers are only supported when an Agent defines one message-shaped Channel")
  })

  it("rejects mixing channels with the legacy chat capability", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { chat } = await import("../src/capabilities.ts")
    const { webChat } = await import("../src/channels.ts")

    expect(() => defineAgent({
      capabilities: [chat()],
      channels: { web: webChat() },
      driver: { run: () => "ok" },
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
      driver: { run: () => ({ text: "ok" }) },
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
      driver: { run: () => ({ text: "ok" }) },
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
      driver: { run: () => ({ text: "ok" }) },
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
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return await this.generate()
        }
      },
      isStepCount: () => () => false,
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
        driver: { model: {} as never },
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

  it("exposes capability output extensions to later renderers by capability id", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "usage-note",
          output(context) {
            context.output.provide({ summary: "12 tokens", usageRecord: { id: "usage-1" } })
          },
        }),
        defineCapability({
          id: "summary-output",
          output(context) {
            context.output.render((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary: string }>("usage-note")
              const summary = renderContext.output.extensions.get<string>("usage-note", "summary")
              const missing = renderContext.output.extensions.get("missing")
              return `${result}:${usage?.summary}:${summary}:${String(missing)}`
            })
          },
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("ok:12 tokens:12 tokens:undefined")
  })

  it("keeps normal output extensions visible to final renderers", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "usage-note",
          output(context) {
            context.output.provide({ summary: "12 tokens" })
            context.output.render(() => "plain")
          },
        }),
        defineCapability({
          id: "summary-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const summary = renderContext.output.extensions.get<string>("usage-note", "summary")
              return `${result}:${summary}`
            })
          },
        }),
      ],
      driver: { run: () => ({ text: "ok" }) },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("plain:12 tokens")
  })

  it("keeps one-argument output render callbacks working", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "legacy-render",
          output(context) {
            context.output.render(result => `${result}:rendered`)
          },
        }),
      ],
      driver: { run: () => "ok" },
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("ok:rendered")
  })

  it("runs stream finish hooks with rendered model-backed object results", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
        async stream() {
          return await this.generate()
        }
      },
      isStepCount: () => () => false,
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
        driver: { model: {} as never },
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

  it("runs stream finish hooks with accumulated model-backed text", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { text: "unused" }
        }
        async stream() {
          return {
            fullStream: (async function* () {
              yield { text: "streamed ", type: "text-delta" }
              yield { text: "review", type: "text-delta" }
              yield { type: "finish" }
            })(),
          }
        }
      },
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        hooks: {
          "agent:finish": finish,
        },
        driver: { model: {} as never },
      })

      const stream = await streamAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})

      for await (const _event of stream as AsyncIterable<unknown>) {}

      expect(finish).toHaveBeenCalledWith(expect.objectContaining({
        result: expect.objectContaining({ text: "streamed review" }),
      }))
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("finalizes model-backed results before finish hooks", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return {
            text: "ok",
            usage: {
              inputTokens: 4,
              outputTokens: 2,
            },
          }
        }
      },
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
      const { usageTelemetry } = await import("../src/capabilities.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [
          usageTelemetry({ summary: { subject: "Model run" } }),
          defineCapability({
            id: "model-output",
            output(context) {
              context.output.final((result, renderContext) => {
                const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
                return {
                  ...result as Record<string, unknown>,
                  text: `${(result as { text?: string }).text}\n${usage?.summary}`,
                }
              })
            },
          }),
        ],
        hooks: {
          "agent:finish": finish,
        },
        driver: { model: {} as never },
      })

      await expect(runAgent(agent, {
        memo: vi.fn(),
        runtime: "unknown",
        waitUntil: vi.fn(),
      }, {})).resolves.toMatchObject({
        text: "ok\nModel run used 6 tokens: 4 in / 2 out.",
        usageRecord: {
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6,
          },
        },
      })
      expect(finish.mock.calls[0]![0].result).toMatchObject({
        text: "ok\nModel run used 6 tokens: 4 in / 2 out.",
      })
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("runs final output renderers before finish delivery effects", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const delivered = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ summary: { subject: "Review run" } }),
        defineCapability({
          id: "delivery-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
            context.delivery.finishEffect(event => ({
              kind: "reply",
              payload: (event.result as { text?: string }).text,
            }))
          },
        }),
      ],
      channels: {
        review: defineChannel("review", {
          effects: {
            reply({ effect }) {
              delivered(effect.payload)
            },
          },
          messages: false,
        }),
      },
      driver: { run: () => ({
          fullStream: (async function* () {
            yield { text: "raw ", type: "text-delta" }
            yield { text: "review", type: "text-delta" }
            yield {
              totalUsage: {
                inputTokens: 10,
                outputTokens: 5,
              },
              type: "finish",
            }
          })(),
        }) },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: {
        channelId: "review",
        runId: "run-1",
      },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})

    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "raw ", type: "text-delta" },
      { text: "review", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        }),
      },
      { type: "finish" },
    ])
    expect(delivered).toHaveBeenCalledWith("raw review\nReview run used 15 tokens: 10 in / 5 out.")
  })

  it("runs final output renderers for bare event streams before finish delivery effects", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const delivered = vi.fn()

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "bare-stream-output",
          output(context) {
            context.output.final(result => ({
              ...result as Record<string, unknown>,
              text: `${(result as { text?: string }).text}:final`,
            }))
            context.delivery.finishEffect(event => ({
              kind: "reply",
              payload: (event.result as { text?: string }).text,
            }))
          },
        }),
      ],
      channels: {
        review: defineChannel("review", {
          effects: {
            reply({ effect }) {
              delivered(effect.payload)
            },
          },
          messages: false,
        }),
      },
      driver: { run: () => (async function* () {
          yield { text: "bare ", type: "text-delta" }
          yield { text: "stream", type: "text-delta" }
          yield { type: "finish" }
        })() },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: {
        channelId: "review",
        runId: "run-1",
      },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})

    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "bare ", type: "text-delta" },
      { text: "stream", type: "text-delta" },
      { type: "finish" },
    ])
    expect(delivered).toHaveBeenCalledWith("bare stream:final")
  })

  it("carries bare stream usage events into final output renderers", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const delivered = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ summary: { subject: "Review run" } }),
        defineCapability({
          id: "bare-usage-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
            context.delivery.finishEffect(event => ({
              kind: "reply",
              payload: (event.result as { text?: string }).text,
            }))
          },
        }),
      ],
      channels: {
        review: defineChannel("review", {
          effects: {
            reply({ effect }) {
              delivered(effect.payload)
            },
          },
          messages: false,
        }),
      },
      driver: { run: () => (async function* () {
          yield { text: "bare ", type: "text-delta" }
          yield { text: "review", type: "text-delta" }
          yield {
            type: "usage",
            usageRecord: {
              usage: {
                inputTokens: 3,
                outputTokens: 4,
                totalTokens: 7,
              },
            },
          }
          yield { type: "finish" }
        })() },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: {
        channelId: "review",
        runId: "run-1",
      },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})

    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(delivered).toHaveBeenCalledWith("bare review\nReview run used 7 tokens: 3 in / 4 out.")
  })

  it("defers runAgent final renderers for bare streams until consumption", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "run-stream-output",
          output(context) {
            context.output.final(result => ({
              ...result as Record<string, unknown>,
              text: `${(result as { text?: string }).text}:final`,
            }))
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => (async function* () {
          yield { text: "run ", type: "text-delta" }
          yield { text: "stream", type: "text-delta" }
          yield { type: "finish" }
        })() },
    })

    const stream = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(finish).not.toHaveBeenCalled()
    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        text: "run stream:final",
      }),
    }))
  })

  it("exposes explicit stream usage events to final output renderers", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const delivered = vi.fn()
    const onUsage = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ onUsage, summary: { subject: "Review run" } }),
        defineCapability({
          id: "explicit-usage-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
            context.delivery.finishEffect(event => ({
              kind: "reply",
              payload: (event.result as { text?: string }).text,
            }))
          },
        }),
      ],
      channels: {
        review: defineChannel("review", {
          effects: {
            reply({ effect }) {
              delivered(effect.payload)
            },
          },
          messages: false,
        }),
      },
      driver: { run: () => ({
          fullStream: (async function* () {
            yield { text: "raw ", type: "text-delta" }
            yield { text: "review", type: "text-delta" }
            yield {
              type: "usage",
              usageRecord: {
                usage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  totalTokens: 15,
                },
              },
            }
            yield { type: "finish" }
          })(),
        }) },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: {
        channelId: "review",
        runId: "run-1",
      },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {})

    const events: unknown[] = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "raw ", type: "text-delta" },
      { text: "review", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      },
      { type: "finish" },
    ])
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    }), expect.objectContaining({
      run: expect.objectContaining({ runId: "run-1" }),
    }))
    expect(delivered).toHaveBeenCalledWith("raw review\nReview run used 15 tokens: 10 in / 5 out.")
  })

  it("routes stream final output renderer failures through finish lifecycle", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const finalError = new Error("final failed")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "broken-final-output",
          output(context) {
            context.output.final(() => {
              throw finalError
            })
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
          fullStream: (async function* () {
            yield { text: "ok", type: "text-delta" }
            yield { type: "finish" }
          })(),
        }) },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})

    await expect((async () => {
      for await (const _event of stream as AsyncIterable<unknown>) {}
    })()).rejects.toThrow("final failed")
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      error: finalError,
    }))
  })

  it("runs final output renderers before ui-message-stream finish delivery effects", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { defineChannel } = await import("../src/channels.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const delivered = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ summary: { subject: "Review ui" } }),
        defineCapability({
          id: "delivery-ui-output",
          output(context) {
            context.output.final((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
            context.delivery.finishEffect(event => ({
              kind: "reply",
              payload: (event.result as { text?: string }).text,
            }))
          },
        }),
      ],
      channels: {
        review: defineChannel("review", {
          effects: {
            reply({ effect }) {
              delivered(effect.payload)
            },
          },
          messages: false,
        }),
      },
      driver: { run: () => ({
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({ delta: "ui ", type: "text-delta" })
                controller.enqueue({ delta: "review", type: "text-delta" })
                controller.enqueue({ type: "finish" })
                controller.close()
              },
            })
          },
          usage: {
            inputTokens: 1,
            outputTokens: 2,
          },
        }) },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: {
        channelId: "review",
        runId: "run-1",
      },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, {}, { output: "ui-message-stream" }) as ReadableStream<unknown>
    const reader = stream.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    expect(delivered).toHaveBeenCalledWith("ui review\nReview ui used 3 tokens: 1 in / 2 out.")
  })

  it("runs agent finish hooks after generated streams are consumed", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const order: string[] = []
    const agent = defineAgent({
      hooks: {
        "agent:finish": () => { order.push("finish") },
      },
      driver: { run: () => (async function* () {
          yield "hello"
          order.push("stream:done")
        })() },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})
    expect(order).toEqual([])
    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(order).toEqual(["stream:done", "finish"])
  })

  it("streams custom run fullStream results", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      driver: { run: () => ({
          fullStream: (async function* () {
            yield { text: "ok", type: "text-delta" }
            yield { type: "finish" }
          })(),
        }) },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})

    const events = []
    for await (const event of stream as AsyncIterable<unknown>) {
      events.push(event)
    }
    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      { type: "finish" },
    ])
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
      driver: { run: () => (async function* () {
          yield "hello"
        })() },
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
      driver: { run: () => (async function* () {
          yield { text: "hello", type: "text-delta" }
          yield { type: "finish" }
        })() },
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
      driver: { run: () => (async function* () {
          yield { text: "hello", type: "text-delta" }
          yield { type: "finish" }
        })() },
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
      driver: { run: () => (async function* () {
          yield { text: "hello", type: "text-delta" }
          yield { type: "finish" }
        })() },
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
    vi.doMock("ai", () => ({
      generateText,
      isStepCount: vi.fn(count => ({ count })),
      jsonSchema: vi.fn(schema => schema),
      ToolLoopAgent: class {
        async generate() {
          return { finishReason: "stop", text: "ok" }
        }
      },
    }))

    try {
      const { defineAgent, runAgent } = await import("../src/index.ts")
      const finish = vi.fn()
      const agent = defineAgent({
        capabilities: [chatTitle()],
        hooks: {
          "agent:finish": finish,
        },
        driver: { model: "agent-title-model" as never, },
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
    vi.doMock("ai", () => ({ generateText, jsonSchema: vi.fn(schema => schema) }))

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
        driver: { run: () => ({ text: "ok" }) },
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
      jsonSchema: vi.fn(schema => schema),
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
      isStepCount: () => () => false,
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")
      const agent = defineAgent({
        capabilities: [chatTitle({ execute: () => "Adapter title" })],
        driver: { model: {} as never },
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
      driver: { run: () => new StreamResult() },
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
      driver: { run: () => new TextStreamResult() },
    })

    const result = await runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({ role: "user", text: "First user request" })],
    }) as TextStreamResult & { stream?: AsyncIterable<unknown> }
    const events = []
    for await (const event of result.stream as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toContainEqual({ data: { title: "Metadata title", type: "chat-title" }, type: "data" })
    expect(events).toContainEqual({ text: "hello", type: "text-delta" })
    expect(result).toBeInstanceOf(TextStreamResult)
    expect(result.metadata).toEqual({ usage: "kept" })
    expect(result.textStream).toBeDefined()
    expect(result.stream).toBeDefined()
    await expect(result.toTextStreamResponse().text()).resolves.toBe("native text")
    expect(finish.mock.calls[0]![0].result).toBe(result)
  })

  it("emits chat title data for UI message streams", async () => {
    const { createUIMessageStream, readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Sidebar title" })],
      driver: { run: () => ({
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
        }) },
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
      driver: { run: () => ({
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
        }) },
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

  it("normalizes valid capability CLI input errors in native UI message streams", async () => {
    const { createUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => ({
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: "assistant-1" })
                writer.write({
                  errorText: "An error occurred.",
                  input: { argv: ["purchase-orders", "--json"] },
                  toolCallId: "cli-1",
                  toolMetadata: {
                    cli: "portal-api",
                    vitehubCapabilityCli: true,
                  },
                  toolName: "portal-api",
                  type: "tool-input-error",
                } as never)
                writer.write({
                  errorText: "Invalid input.",
                  input: { argv: ["list"], extra: true, json: "true" },
                  toolCallId: "cli-invalid",
                  toolMetadata: {
                    cli: "portal-api",
                    vitehubCapabilityCli: true,
                  },
                  toolName: "portal-api",
                  type: "tool-input-error",
                } as never)
                writer.write({
                  output: {
                    command: "portal-api purchase-orders --json",
                    exitCode: 0,
                  },
                  toolCallId: "cli-1",
                  type: "tool-output-available",
                })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }) },
    })

    const stream = await streamAgent(agent, { memo: vi.fn(), runtime: "unknown", traceLog, waitUntil: vi.fn() }, {}, { output: "ui-message-stream" }) as ReadableStream<unknown>
    const chunks: unknown[] = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks).toContainEqual(expect.objectContaining({
      input: { argv: ["purchase-orders", "--json"] },
      toolCallId: "cli-1",
      toolName: "portal-api",
      type: "tool-input-available",
    }))
    expect(chunks).not.toContainEqual(expect.objectContaining({
      toolCallId: "cli-1",
      type: "tool-input-error",
    }))
    expect(chunks).toContainEqual(expect.objectContaining({
      input: { argv: ["list"], extra: true, json: "true" },
      toolCallId: "cli-invalid",
      type: "tool-input-error",
    }))
    expect(traceLog.entries()).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "tool.hasInput": true,
        "tool.id": "cli-1",
        "tool.name": "portal-api",
      }),
      name: "agent.tool.start",
    }))
    expect(traceLog.entries()).not.toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({ "tool.id": "cli-invalid" }),
      name: "agent.tool.start",
    }))
  })

  it("traces fullStream results when UI message streams are requested", async () => {
    const { createUIMessageStream, readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => ({
          fullStream: (async function* () {
            yield { input: { query: "users" }, toolCallId: "tool-1", toolName: "search", type: "tool-call" }
            yield { output: "42", toolCallId: "tool-1", toolName: "search", type: "tool-result" }
            yield { finishReason: "stop", type: "finish" }
          })(),
          toUIMessageStream() {
            return createUIMessageStream({
              execute({ writer }) {
                writer.write({ type: "start", messageId: "assistant-1" })
                writer.write({ type: "text-start", id: "text-1" })
                writer.write({ type: "text-delta", id: "text-1", delta: "native answer" })
                writer.write({ type: "text-end", id: "text-1" })
                writer.write({ input: { query: "users" }, toolCallId: "tool-1", toolName: "search", type: "tool-input-available" })
                writer.write({ output: "42", toolCallId: "tool-1", type: "tool-output-available" })
                writer.write({ type: "finish", finishReason: "stop" })
              },
            })
          },
        }) },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      trace: { id: "request-1" },
      traceLog,
      waitUntil: vi.fn(),
    }, {
      messages: [createMessage({ role: "user", text: "Explain availability" })],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(messages.at(-1)?.parts).toContainEqual(expect.objectContaining({
      text: "native answer",
      type: "text",
    }))
    expect(messages.at(-1)?.parts.some(part => part.type === "tool-search")).toBe(true)
    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.tool.start",
      "agent.tool.finish",
      "agent.stream.finish",
      "agent.invocation.finish",
    ])
    expect(deriveTraceRuns(traceLog.entries()).map(run => run.id)).toEqual(["run-1"])
  })

  it("preserves native UI message result metadata for traced finish renderers", async () => {
    const { createUIMessageStream, readUIMessageStream } = await import("ai")
    const { defineCapability } = await import("../src/capability-runtime.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const finish = vi.fn()

    class NativeUiResult {
      metadata = { id: "native-result" }
      text = "existing text"
      usageRecord = { usage: { totalTokens: 3 } }

      describe() {
        return this.metadata.id
      }

      toUIMessageStream() {
        return createUIMessageStream({
          execute({ writer }) {
            writer.write({ type: "start", messageId: "assistant-1" })
            writer.write({ type: "text-start", id: "text-1" })
            writer.write({ type: "text-delta", id: "text-1", delta: "native answer" })
            writer.write({ type: "text-end", id: "text-1" })
            writer.write({ type: "finish", finishReason: "stop" })
          },
        })
      }
    }

    const nativeResult = new NativeUiResult()
    const finalRenderer = vi.fn((result: unknown) => {
      expect(result).toBe(nativeResult)
      expect(result).toBeInstanceOf(NativeUiResult)
      expect((result as NativeUiResult).metadata).toBe(nativeResult.metadata)
      expect((result as NativeUiResult).usageRecord).toBe(nativeResult.usageRecord)
      expect((result as NativeUiResult).describe()).toBe("native-result")
      return result
    })
    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "native-ui-result-assertion",
          output(context) {
            context.output.final(finalRenderer)
          },
        }),
      ],
      driver: { run: () => nativeResult },
      hooks: {
        "agent:finish": finish,
      },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {}, { output: "ui-message-stream" }) as ReadableStream<never>
    for await (const _message of readUIMessageStream({ stream })) {}

    expect(finalRenderer).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].result).toBe(nativeResult)
    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.stream.finish",
      "agent.invocation.finish",
    ])
  })

  it("traces native UI results with non-configurable own UI stream methods", async () => {
    const { createUIMessageStream, readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const nativeResult = { metadata: { id: "native-result" } }
    Object.defineProperty(nativeResult, "toUIMessageStream", {
      value() {
        return createUIMessageStream({
          execute({ writer }) {
            writer.write({ type: "start", messageId: "assistant-1" })
            writer.write({ type: "text-start", id: "text-1" })
            writer.write({ type: "text-delta", id: "text-1", delta: "native answer" })
            writer.write({ type: "text-end", id: "text-1" })
            writer.write({ type: "finish", finishReason: "stop" })
          },
        })
      },
    })
    const agent = defineAgent({
      driver: { run: () => nativeResult },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {}, { output: "ui-message-stream" }) as ReadableStream<never>
    const messages = []
    for await (const message of readUIMessageStream({ stream })) {
      messages.push(message)
    }

    expect(Object.getOwnPropertyDescriptor(nativeResult, "toUIMessageStream")?.configurable).toBe(false)
    expect(messages.at(-1)?.parts).toContainEqual(expect.objectContaining({
      text: "native answer",
      type: "text",
    }))
    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.stream.finish",
      "agent.invocation.finish",
    ])
  })

  it("traces direct async iterable results when UI message streams are requested", async () => {
    const { readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      driver: { run: () => (async function* () {
          yield { id: "tool-1", input: { query: "users" }, name: "search", type: "tool-call" }
          yield { id: "tool-1", name: "search", output: "42", type: "tool-result" }
          yield { type: "finish" }
        })() },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      traceLog,
      waitUntil: vi.fn(),
    }, {}, { output: "ui-message-stream" }) as ReadableStream<never>
    for await (const _message of readUIMessageStream({ stream })) {}

    expect(traceLog.entries().map(event => event.name)).toEqual([
      "agent.invocation.start",
      "agent.tool.start",
      "agent.tool.finish",
      "agent.stream.finish",
      "agent.invocation.finish",
    ])
  })

  it("does not drain traced UI message streams ahead of the caller", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    let pulls = 0
    let cancelReason: unknown
    let releaseBlockedPull: (() => void) | undefined
    const agent = defineAgent({
      driver: { run: () => ({
          fullStream: (async function* () {
            yield { type: "finish" }
          })(),
          toUIMessageStream() {
            return new ReadableStream({
              pull(controller) {
                pulls += 1
                if (pulls === 1) {
                  controller.enqueue({ type: "start", messageId: "assistant-1" })
                  return
                }
                return new Promise<void>((resolve) => {
                  releaseBlockedPull = resolve
                })
              },
              cancel(reason) {
                cancelReason = reason
                releaseBlockedPull?.()
              },
            })
          },
        }) },
    })

    const stream = await streamAgent(agent, {
      memo: vi.fn(),
      run: { runId: "run-1" },
      runtime: "unknown",
      trace: { id: "request-1" },
      traceLog: createTraceEventLog(),
      waitUntil: vi.fn(),
    }, {
      messages: [createMessage({ role: "user", text: "Explain availability" })],
    }, { output: "ui-message-stream" }) as ReadableStream<never>
    await Promise.resolve()
    await Promise.resolve()

    expect(pulls).toBeLessThanOrEqual(2)
    const cancelResult = await Promise.race([
      stream.cancel("client disconnected").then(() => "cancelled"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 50)),
    ])
    releaseBlockedPull?.()

    expect(cancelResult).toBe("cancelled")
    expect(cancelReason).toBe("client disconnected")
  })

  it("emits one chat title data part when async event streams become UI message streams", async () => {
    const { readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chatTitle({ execute: () => "Async title" })],
      driver: { run: () => (async function* () {
          yield { text: "answer", type: "text-delta" }
          yield { type: "finish" }
        })() },
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
      driver: { run: () => (async function* () {
          yield { text: "answer", type: "text-delta" }
          yield { type: "finish" }
        })() },
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
      driver: { run: () => ({ text: "ok" }) },
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
      driver: { run: () => new Response("ok") },
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
      driver: { run: () => new Response(new ReadableStream({
          pull() {
            throw error
          },
        })) },
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
      driver: { run: () => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"))
          },
        })) },
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
      driver: { run: () => new Response(body) },
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
        sessions: { idleTimeoutMs: 30 * 60 * 1000, strategy: "idle-timeout" },
        triggerHistory: { maxMessages: 10, source: "thread" },
      })],
      driver: { run: () => "ok" },
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

    if ("response" in invocation) throw new Error("Expected chat trigger invocation input.")
    expect(invocation.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["new topic"])
  })

  it("defaults zero-argument chat options and preserves completed UI tool calls", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat()],
      driver: { run: () => "ok" },
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

    if ("response" in invocation) throw new Error("Expected chat trigger invocation input.")
    expect(invocation.input.messages?.[0]?.parts).toEqual([
      { id: "tool-1", input: { query: "users" }, name: "search", state: "proposed", type: "tool-call" },
      { id: "tool-1", name: "search", output: "42", state: "completed", type: "tool-result" },
    ])
  })

  it("omits chat thinking fallback metadata when the placeholder is unset", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat()],
      driver: { run: () => "ok" },
    })

    const invocation = await resolveAgentTriggerInvocation(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [createMessage({ role: "user", text: "hello" })],
    })

    if ("response" in invocation) throw new Error("Expected chat trigger invocation input.")
    expect(invocation.metadata).toBeUndefined()
  })

  it("preserves disabled chat thinking fallback metadata", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat({ fallbackStreamingPlaceholderText: null })],
      driver: { run: () => "ok" },
    })

    const invocation = await resolveAgentTriggerInvocation(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [createMessage({ role: "user", text: "hello" })],
    })

    if ("response" in invocation) throw new Error("Expected chat trigger invocation input.")
    expect(invocation.metadata).toEqual({ thinkingFallback: null })
  })

  it("disables chat thinking fallback metadata for empty placeholder arrays", async () => {
    const { defineAgent, resolveAgentTriggerInvocation } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [chat({ fallbackStreamingPlaceholderText: [] })],
      driver: { run: () => "ok" },
    })

    const invocation = await resolveAgentTriggerInvocation(agent, {
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, "chat.message", {
      messages: [createMessage({ role: "user", text: "hello" })],
    })

    if ("response" in invocation) throw new Error("Expected chat trigger invocation input.")
    expect(invocation.metadata).toEqual({ thinkingFallback: null })
  })

  it("converts async stream events to AI SDK UI message streams", async () => {
    const { readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      driver: { run: () => (async function* () {
          yield { data: { title: "Async title", type: "chat-title" }, type: "data" }
          yield { text: "hello", type: "text-delta" }
          yield { id: "tool-1", input: { query: "users" }, name: "search", type: "tool-call" }
          yield { id: "tool-1", name: "search", output: "42", type: "tool-result" }
          yield { type: "finish" }
        })() },
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
        sessions: true,
        triggerHistory: { maxMessages: 10, source: "thread" },
      })],
      driver: { run: () => "ok" },
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

    if ("response" in invocation) throw new Error("Expected chat trigger invocation input.")
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
      driver: { model: {} as never },
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

  it("converts static capability tool execution results to JSON-compatible values", async () => {
    const { defineAgent } = await import("../src/index.ts")

    const agent = defineAgent({
      driver: { model: {} as never },
      capabilities: [{
        id: "lookup-tools",
        tools: {
          lookup: {
            execute: (_input: unknown) => ({ timestamp: new Date("2026-06-22T19:30:00.000Z") }),
            name: "lookup",
          },
        },
      }],
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.lookup!.execute({})).resolves.toEqual({
      timestamp: "2026-06-22T19:30:00.000Z",
    })
  })

  it("skips Capability CLI tools on static model resolves", async () => {
    const { defineAgent, defineCapability } = await import("../src/index.ts")

    const agent = defineAgent({
      driver: { model: {} as never, },
      capabilities: [
        defineCapability({
          cli: {
            commands: {
              list: {
                run: () => "cli",
              },
            },
            name: "inventory",
          },
          id: "inventory-runtime",
          tools: {
            lookup: {
              execute: () => "tool",
              name: "lookup",
            },
          },
        }),
      ],
    })
    const resolved = await agent.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }) as unknown as { tools?: Record<string, { execute?: (input: unknown) => Promise<unknown> }> }

    expect(Object.keys(resolved.tools || {})).toEqual(["lookup"])
    expect(resolved.tools?.inventory).toBeUndefined()
    await expect(resolved.tools?.lookup?.execute?.({})).resolves.toBe("tool")
  })

  it("resolves static subagent tools with the resolved runtime context", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const browserAgent = {
      async resolve(context) {
        return {
          async generate({ runtime }) {
            return {
              raw: {
                resolveRuntimeConfig: context.runtimeConfig,
                runtimeConfig: runtime.runtimeConfig,
              },
              text: "browser report",
            }
          },
          name: "browser",
        }
      },
    } as ReturnType<typeof defineAgent>
    const reviewerAgent = defineAgent({
      capabilities: [
        subagents({
          agents: {
            browser: {
              agent: browserAgent,
              description: "Collect browser evidence.",
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    const resolved = await reviewerAgent.resolve({
      memo: vi.fn(),
      runtime: "unknown",
      runtimeConfig: { region: "iad" },
      waitUntil: vi.fn(),
    }) as unknown as { tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> }

    await expect(resolved.tools.run_browser!.execute({ message: "Check the product card." })).resolves.toMatchObject({
      raw: {
        raw: {
          resolveRuntimeConfig: { region: "iad" },
          runtimeConfig: { region: "iad" },
        },
      },
      text: "browser report",
    })
  })

  it("prevents denied tools from executing", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const execute = vi.fn()

    const agent = defineAgent({
      driver: { model: {} as never },
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
      driver: { model: {} as never },
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

    expect(sandbox({ commands: ["node"] }).tools).toEqual(expect.any(Function))

    expect(() => defineAgent({
      capabilities: [{ id: "custom" }, { id: "custom" }],
      driver: { model: {} as never },
    })).toThrow("Duplicate capability id")

    expect(() => defineAgent({
      capabilities: [{} as never],
      driver: { model: {} as never },
    })).toThrow("require a non-empty string id")

    expect(() => defineAgent({
      capabilities: [sandbox({ commands: ["pnpm test"] })],
      driver: { model: {} as never },
      workspace: {},
    })).toThrow("executable names only")

    expect(() => defineAgent({
      capabilities: [workspaceShell()],
      driver: { model: {} as never },
    })).toThrow("requires an explicit workspace")

    expect(() => defineAgent({
      capabilities: [workspaceShell({ mode: "write" })],
      driver: { model: {} as never },
      workspace: { mode: "read" },
    })).toThrow("requires workspace.mode")
  })

  it("fails when a primitive capability has no backing primitive", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { kv } = await import("../src/capabilities.ts")
    const agent = defineAgent({
      capabilities: [kv()],
      driver: { model: {} as never },
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
        driver: { run: () => ({
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
          }) },
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
        driver: { run: context => `received ${context.prompt}` },
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

    it("uses discovered Agent identity for unnamed workflow runtime bindings", async () => {
      const { defineAgent, runAgent, withAgentDefaults, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const agent = withAgentDefaults(defineAgent({
        runtime: workflow(),
        driver: { run: context => `received ${context.prompt}` },
      }), { inferredName: "browser" })
      const run = await runAgent(agent!, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, { prompt: "hello" }) as { id: string }

      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("browser", run.id)).resolves.toMatchObject({
        result: "received hello",
        status: "completed",
      })
    })

    it("preserves Agent Definition metadata when applying discovered defaults", async () => {
      const { createAgentDevtoolsMetadata, defineAgent, withAgentDefaults, workflow } = await import("../src/index.ts")
      const agent = withAgentDefaults(defineAgent({
        driver: { model: { id: "test-model" } as never },
        runtime: workflow(),
      }), { inferredName: "browser" })

      expect(createAgentDevtoolsMetadata(agent!)).toMatchObject({
        config: {
          driver: {
            kind: "model",
            model: { id: "test-model" },
          },
        },
      })
    })

    it("keeps workspace defaults scoped to each prepared Agent Definition", async () => {
      const { defineAgent } = await import("../src/index.ts")
      const defaults = (agent: unknown) => (agent as { __vitehubWorkspaceAgentDefaults?: { name?: string, workspace?: string } }).__vitehubWorkspaceAgentDefaults
      const agent = defineAgent({
        driver: { run: () => "ok" },
        workspace: {},
      })

      const docsAgent = withAgentDefaults(agent, { inferredName: "docs-agent", workspace: "docs" })
      const supportAgent = withAgentDefaults(agent, { inferredName: "support-agent", workspace: "support" })

      expect(docsAgent).not.toBe(agent)
      expect(supportAgent).not.toBe(agent)
      expect(docsAgent).not.toBe(supportAgent)
      expect(defaults(agent)).toEqual({})
      expect(defaults(docsAgent)).toEqual({ name: "docs-agent", workspace: "docs" })
      expect(defaults(supportAgent)).toEqual({ name: "support-agent", workspace: "support" })
    })

    it("preserves existing workspace defaults when applying an inferred registry name", async () => {
      const { defineAgent } = await import("../src/index.ts")
      const defaults = (agent: unknown) => (agent as { __vitehubWorkspaceAgentDefaults?: { name?: string, workspace?: string } }).__vitehubWorkspaceAgentDefaults
      const agent = defineAgent({
        driver: { run: () => "ok" },
        workspace: {},
      })

      const preparedAgent = withAgentDefaults(agent, { inferredName: "support-agent", workspace: "support" })
      const registryAgent = withAgentDefaults(preparedAgent, { inferredName: "registry-support" })

      expect(registryAgent).not.toBe(preparedAgent)
      expect(defaults(registryAgent)).toEqual({ name: "registry-support", workspace: "support" })
    })

    it("uses workspace Agent defaults for unnamed workflow runtime bindings", async () => {
      const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const agent = withAgentDefaults(defineAgent({
        runtime: workflow(),
        driver: { run: context => `received ${context.prompt}` },
        workspace: {},
      }), { inferredName: "reviewer", workspace: "reviewer" })
      const run = await runAgent(agent, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: promise => waitUntilTasks.push(promise),
      }, { prompt: "hello" }) as { id: string }

      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("reviewer", run.id)).resolves.toMatchObject({
        result: "received hello",
        status: "completed",
      })
    })

    it("requires direct unnamed workflow runtime bindings to provide a name", async () => {
      const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const agent = defineAgent({
        runtime: workflow(),
        driver: { run: () => "ok" },
      })

      await expect(runAgent(agent, {
        memo: vi.fn(),
        runtime: "vercel",
        waitUntil: vi.fn(),
      }, { prompt: "hello" })).rejects.toThrow("requires a name")
    })

    it("passes runtimeConfig through Workflow Runs", async () => {
      const { defineAgent, runAgent, workflow } = await import("../src/index.ts")
      const { getWorkflowRun } = await import("@vite-hub/workflow")
      const { setWorkflowRuntimeConfig } = await import("@vite-hub/workflow/runtime/state")
      const waitUntilTasks: Array<Promise<unknown>> = []
      setWorkflowRuntimeConfig({ provider: "vercel" })

      const agent = {
        runtime: workflow("configured-agent"),
        async resolve(context) {
          return {
            async generate({ runtime }) {
              return {
                raw: {
                  resolveRuntimeConfig: context.runtimeConfig,
                  runtimeConfig: runtime.runtimeConfig,
                },
              }
            },
            name: "configured",
          }
        },
      } as ReturnType<typeof defineAgent>
      const run = await runAgent(agent, {
        memo: vi.fn(),
        runtime: "vercel",
        runtimeConfig: { region: "iad" },
        waitUntil: promise => waitUntilTasks.push(promise),
      }, { prompt: "hello" }) as { id: string }

      await Promise.all(waitUntilTasks)
      await expect(getWorkflowRun("configured-agent", run.id)).resolves.toMatchObject({
        result: {
          raw: {
            raw: {
              resolveRuntimeConfig: { region: "iad" },
              runtimeConfig: { region: "iad" },
            },
          },
        },
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
        driver: {
          run
        },
      })
      const secondAgent = defineAgent({
        runtime: workflow("support-agent"),
        driver: {
          run
        },
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
        driver: { run: context => `received ${context.prompt}` },
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
        driver: { run: context => context.cloudflare?.env?.NUXT_SITE },
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
