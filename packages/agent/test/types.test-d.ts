import { describe, expectTypeOf, it } from "vitest"

import { defineAgent, type AgentRuntimeContext } from "../src/index.ts"
import { blob, db, fetch, getTranscriptionResults, inputCommands, kv, mcp, sandbox, schedule, skills, transcribe, webSearch, workspaceShell } from "../src/capabilities.ts"
import { defineEval, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import type { AgentInvocationContextStore, AgentUsageRecord } from "../src/index.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import type { FetchCapabilityToolOptions, TranscriptionResult } from "../src/capabilities.ts"

describe("agent public types", () => {
  it("accepts capabilities from the capabilities entry", () => {
    defineAgent({
      capabilities: [
        workspaceShell(),
        blob({ mode: "write", policy: () => "allow", store: "assets" }),
        db({ database: "analytics", mode: "write", policy: "allow", schemaMode: "write" }),
        fetch({
          tools: {
            status: {
              inputSchema: {
                "~standard": {
                  validate: (input: unknown) => ({ value: input as { region: string } }),
                },
              },
              request(input) {
                expectTypeOf(input.region).toEqualTypeOf<string>()
                return {
                  query: { region: input.region },
                  url: "https://status.example.com/api/region",
                }
              },
              schema: {
                "~standard": {
                  validate: (input: unknown) => ({ value: input as { status: string } }),
                },
              },
              transform(data) {
                expectTypeOf(data.status).toEqualTypeOf<string>()
                return data.status
              },
            } satisfies FetchCapabilityToolOptions<{ region: string }, { status: string }, string>,
          },
        }),
        inputCommands({
          commands: {
            review: {
              description: "Review the request.",
              run: ({ args }) => `review:${args}`,
            },
          },
        }),
        kv({ mode: "write", policy: "require-approval", store: "chat" }),
        mcp({
          servers: {
            direct: {} as MCPClient,
            factory: () => remoteMcpServer({ type: "sse", url: "https://example.com/sse" }),
            remote: remoteMcpServer({ url: "https://example.com/mcp" }),
            stdio: stdioMcpServer({ command: "node", args: ["server.js"] }),
          },
        }),
        skills(),
        sandbox({ commands: ["node"] }),
        schedule({ mode: "read", targets: ["daily-reports"] as const }),
        schedule({ allowSelfTarget: true, mode: "write", policy: "require-approval", selfTarget: "agent/digest", targets: ["agent/digest", "daily-reports"] as const }),
        transcribe({
          execute({ audio }) {
            expectTypeOf(audio.mediaType).toEqualTypeOf<string>()
            return "transcript"
          },
        }),
        webSearch({ mode: "tool", provider: "exa" }),
        webSearch({ mode: "model" }),
        {
          id: "custom",
          requires: [{ primitive: "workspace", workspace: { paths: ["CONTEXT.md"], required: true } }],
          tools: {
            lookup: { name: "lookup" },
          },
        },
      ],
      model: {} as never,
      workspace: { mode: "read" },
    })

    type GeneratedScheduleTargetName = "daily-reports" | "weekly-cleanup"
    schedule<GeneratedScheduleTargetName>({ mode: "write", targets: ["daily-reports"] })
    // @ts-expect-error target allowlists are typed by generated Schedule Target Names where supplied
    schedule<GeneratedScheduleTargetName>({ mode: "write", targets: ["missing"] })

    // @ts-expect-error web search mode is required
    webSearch({})

    // @ts-expect-error tool mode requires one explicit provider
    webSearch({ mode: "tool" })

    const invocationContext: AgentInvocationContextStore = {
      entries: () => new Map<string, unknown>().entries(),
      get: () => undefined,
      has: () => false,
      set: () => undefined,
      toJSON: () => ({}),
    }
    expectTypeOf(getTranscriptionResults(invocationContext)).toEqualTypeOf<TranscriptionResult[]>()
    expectTypeOf(getTranscriptionResults({ context: invocationContext })).toEqualTypeOf<TranscriptionResult[]>()

    defineAgent({
      model: {} as never,
      hooks: {
        "agent:finish"(event) {
          expectTypeOf(event.extensions.get<AgentUsageRecord>("usage-telemetry")).toEqualTypeOf<AgentUsageRecord | undefined>()
        },
      },
    })

    defineAgent({
      capabilities: [{
        id: "finish-extension",
        output(context) {
          context.finish.provide("ok")
          // @ts-expect-error finish extensions are registered through context.finish
          context.extensions.provide("agent:finish", "ok")
        },
      }],
      model: {} as never,
    })

    defineAgent({
      model: {} as never,
      // @ts-expect-error root-level tools are not public API
      tools: {},
    })

    // @ts-expect-error workspace mode must be read or write
    defineAgent({
      model: {} as never,
      workspace: { mode: "mutable" },
    })

    defineAgent({
      model: {} as never,
      // @ts-expect-error adapter settings belong under adapterOptions
      temperature: 0.2,
    })

    inputCommands({
      commands: {
        // @ts-expect-error input commands require user-facing descriptions
        review: {
          run: () => undefined,
        },
      },
    })

    type RootAgentExports = typeof import("../src/index.ts")
    // @ts-expect-error official capability factories are not root Agent Package exports
    type _RootInputCommands = RootAgentExports["inputCommands"]

    type CapabilityExports = typeof import("../src/capabilities.ts")
    // @ts-expect-error transcription byte conversion is internal, not public capabilities API
    type _PublicAudioBytes = CapabilityExports["audioBytes"]
    // @ts-expect-error transcription extension inference is internal, not public capabilities API
    type _PublicAudioExtensionFor = CapabilityExports["audioExtensionFor"]
    // @ts-expect-error transcription context storage key is internal, not public capabilities API
    type _PublicTranscriptionContextKey = CapabilityExports["TRANSCRIPTION_RESULTS_CONTEXT_KEY"]
  })

  it("accepts agent eval definitions", () => {
    const scorer: AgentScorer = textContains("ok")
    const definition: AgentEvalDefinition = {
      agent: defineAgent({
        model: {} as never,
      }),
      scenarios: [{
        input: { prompt: "hello" },
        metadata: { area: "support" },
        name: "hello",
        scorers: [scorer],
      }],
      scorers: [scorer],
      variants: [{ name: "strict", instructions: "Be strict.", model: {} }],
    }

    defineEval(definition)

    const observation: AgentObservation = {
      raw: {},
      scenario: "hello",
      text: "ok",
      toolSteps: [],
      variant: "baseline",
    }

    scorer.score(observation)
  })

  it("preserves agent eval runtime config types", () => {
    interface TestRuntimeConfig {
      service: {
        token: string
      }
    }

    const agent = defineAgent<TestRuntimeConfig>({
      model: ({ runtimeConfig }: AgentRuntimeContext<TestRuntimeConfig> & { runtimeConfig: TestRuntimeConfig }) => {
        runtimeConfig.service.token.toUpperCase()
        return {} as never
      },
      workspace: { mode: "read" },
    })

    defineEval<TestRuntimeConfig>({
      agent,
      runtimeConfig: {
        service: {
          token: "secret",
        },
      },
      scenarios: [{
        input: { prompt: "hello" },
        name: "hello",
      }],
    })

    defineEval<TestRuntimeConfig>({
      // @ts-expect-error eval agent runtime config must match the eval runtime config
      agent: defineAgent<{ other: string }>({
        model: {} as never,
        workspace: { mode: "read" },
      }),
      runtimeConfig: {
        service: {
          token: "secret",
        },
      },
      scenarios: [{
        input: { prompt: "hello" },
        name: "hello",
      }],
    })

    defineEval<TestRuntimeConfig>({
      agent,
      runtimeConfig: {
        service: {
          token: "secret",
        },
      },
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      // @ts-expect-error eval definitions do not expose test runner request plumbing
      request: new Request("https://example.com"),
    })

    defineEval<TestRuntimeConfig>({
      agent,
      runtimeConfig: {
        service: {
          token: "secret",
        },
      },
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      // @ts-expect-error eval definitions do not expose test runner runtime plumbing
      runtime: "nitro",
    })

    defineEval<TestRuntimeConfig>({
      agent,
      runtimeConfig: {
        service: {
          token: "secret",
        },
      },
      scenarios: [{ input: { prompt: "hello" }, name: "hello" }],
      // @ts-expect-error eval definitions do not expose test runner waitUntil plumbing
      waitUntil: () => {},
    })
  })
})
