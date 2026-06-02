import { describe, expectTypeOf, it } from "vitest"

import { defineAgent, type AgentRuntimeContext } from "../src/index.ts"
import { access, blob, chat, chatTitle, db, fetch, getTranscriptionResults, inputCommands, kv, mcp, sandbox, schedule, skills, transcribe, webSearch, workspaceShell } from "../src/capabilities.ts"
import { defineEval, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import type { AgentInvocationContextStore, AgentUsageRecord } from "../src/index.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import { source } from "@vite-hub/workspace"
import type { AccessCapabilityStandardSchemaV1, AccessWorkspaceOptionsFor, AgentChatAdapterResolver, AgentChatRunContext, FetchCapabilityToolOptions, TranscriptionResult } from "../src/capabilities.ts"

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
        chatTitle({
          model: () => ({}),
          template({ fallback, maxLength, text, trigger }) {
            expectTypeOf(fallback).toEqualTypeOf<string>()
            expectTypeOf(maxLength).toEqualTypeOf<number>()
            expectTypeOf(text).toEqualTypeOf<string>()
            expectTypeOf(trigger).toEqualTypeOf<string | undefined>()
            return text
          },
          trigger: "chat.message",
          variables: {
            suffix: ({ text }) => text,
          },
          when: ({ input }) => {
            expectTypeOf(input.context).toEqualTypeOf<Record<string, unknown> | undefined>()
            return true
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
      capabilities: [
        transcribe({
          execute: () => "transcript",
          artifacts: {
            audio: {
              path({ audioExtension, date, stem }) {
                expectTypeOf(audioExtension).toEqualTypeOf<string>()
                return `audio/${date}/${stem}.${audioExtension}`
              },
            },
            transcript: {
              path({ date, stem }) {
                expectTypeOf(date).toEqualTypeOf<string>()
                expectTypeOf(stem).toEqualTypeOf<string>()
                return `${date}/${stem}.md`
              },
              template({ audioPath, transcriptPath, transcript }) {
                expectTypeOf(audioPath).toEqualTypeOf<string | undefined>()
                expectTypeOf(transcriptPath).toEqualTypeOf<string | undefined>()
                expectTypeOf(transcript).toEqualTypeOf<string>()
                return transcript
              },
            },
          },
        }),
      ],
      model: {} as never,
      workspace: { mode: "write" },
    })

    transcribe({
      execute: () => "transcript",
      artifacts: {
        // @ts-expect-error transcription artifacts do not accept directory builders
        directory: "inbox",
      },
    })

    transcribe({
      execute: () => "transcript",
      artifacts: {
        transcript: {
          path: "inbox/transcript.md",
          // @ts-expect-error transcript media type is inferred from path or set through mediaType
          extension: "md",
        },
      },
    })

    transcribe({
      execute: () => "transcript",
      artifacts: {
        transcript: false,
        audio: {
          path: ({ audioExtension, date, stem }) => `audio/${date}/${stem}.${audioExtension}`,
        },
      },
    })

    transcribe({
      execute: () => "transcript",
      // @ts-expect-error output was renamed to artifacts
      output: {
        path: "inbox/transcript.md",
      },
    })

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
    // @ts-expect-error Capability Type Contracts are not a public custom-Capability extension point
    type _RootAgentCapabilityTypeContract = RootAgentExports["AgentCapabilityTypeContract"]

    type CapabilityExports = typeof import("../src/capabilities.ts")
    type _PublicAudioBytes = CapabilityExports["audioBytes"]
    // @ts-expect-error Access Capability Type Contract is internal to access() inference
    type _PublicAccessCapabilityTypeContract = CapabilityExports["AccessCapabilityTypeContract"]
    // @ts-expect-error transcription extension inference is internal, not public capabilities API
    type _PublicAudioExtensionFor = CapabilityExports["audioExtensionFor"]
    // @ts-expect-error transcription context storage key is internal, not public capabilities API
    type _PublicTranscriptionContextKey = CapabilityExports["TRANSCRIPTION_RESULTS_CONTEXT_KEY"]
  })

  it("types access workspace source grants and chat run context", () => {
    const workspace = {
      sources: {
        docs: source.file("AGENTS.md"),
        forecastingEngine: source.github({ repo: "acme/forecasting-engine" }),
      },
    }
    type ChatContext = AgentChatRunContext<
      { quiver?: { customer?: string } },
      { email?: string },
      "portal" | "teams"
    >
    const workspaceAccess: AccessWorkspaceOptionsFor<typeof workspace, ChatContext> = {
      defaultScope: "customer",
      resolve({ input }) {
        const chat = input.get().context?.chat
        expectTypeOf(chat?.message?.metadata?.quiver?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.run?.origin).toEqualTypeOf<"portal" | "teams" | undefined>()
        expectTypeOf(chat?.user?.email).toEqualTypeOf<string | undefined>()
        return chat?.user?.email?.endsWith("@quiver.dk")
          ? { role: "admin", scope: "quiver" }
          : "customer"
      },
      scopes: {
        customer: {
          grants: [
            { path: "AGENTS.md" },
            { source: "forecastingEngine" },
            { sources: ["docs"] },
          ],
        },
        quiver: { all: true },
      },
    }
    access({ workspace: workspaceAccess })

    const inlineWorkspaceAccess: AccessWorkspaceOptionsFor<typeof workspace, ChatContext> = {
      resolve({ input }) {
        const customer = input.get().context?.chat?.message?.metadata?.quiver?.customer || "public"
        return {
          grants: [
            { path: "AGENTS.md" },
            { source: "forecastingEngine" },
            { path: `ingestion/${customer}` },
          ],
          scope: customer,
        }
      },
    }
    access({ workspace: inlineWorkspaceAccess })

    const invalidAccess: AccessWorkspaceOptionsFor<typeof workspace> = {
      scopes: {
        customer: {
          grants: [
            // @ts-expect-error source grants are limited to the workspace source map
            { source: "missing" },
          ],
          // @ts-expect-error source grants are limited to the workspace source map
          sources: ["missing"],
        },
      },
    }
    expectTypeOf(invalidAccess).toMatchTypeOf<AccessWorkspaceOptionsFor<typeof workspace>>()

    const invalidInlineAccess: AccessWorkspaceOptionsFor<typeof workspace> = {
      // @ts-expect-error inline source grants are limited to the workspace source map
      resolve: () => ({
        scope: "customer",
        source: "missing",
      }),
    }
    expectTypeOf(invalidInlineAccess).toMatchTypeOf<AccessWorkspaceOptionsFor<typeof workspace>>()
  })

  it("types inline access source grants and chat input schemas from defineAgent", () => {
    interface SupportMessageMetadata {
      quiver?: {
        customer?: string
      }
    }
    interface SupportChatUser {
      email?: string
    }
    const metadataSchema = {
      "~standard": {
        validate: (input: unknown) => ({ value: input as SupportMessageMetadata }),
      },
    } satisfies AccessCapabilityStandardSchemaV1<SupportMessageMetadata>
    const userSchema = {
      "~standard": {
        validate: (input: unknown) => ({ value: input as SupportChatUser }),
      },
    } satisfies AccessCapabilityStandardSchemaV1<SupportChatUser>
    const teamsAdapter = {} as AgentChatAdapterResolver
    const supportChat = chat({
      adapters: () => ({ teams: teamsAdapter }),
      app: "portal",
      identity({ adapter, author }) {
        expectTypeOf(adapter).toEqualTypeOf<string>()
        expectTypeOf(author.userId).toEqualTypeOf<string>()
        return `${adapter}:${author.userId}`
      },
      transcripts: {
        maxPerUser: 50,
        retention: "30d",
      },
    })

    defineAgent({
      capabilities: [
        access({
          input: {
            chat: {
              capability: supportChat,
              message: { metadata: metadataSchema },
              user: userSchema,
            },
          },
          workspace: {
            resolve({ input }) {
              const chat = input.get().context?.chat
              expectTypeOf(chat?.message?.metadata?.quiver?.customer).toEqualTypeOf<string | undefined>()
              expectTypeOf(chat?.run?.origin).toEqualTypeOf<"portal" | "teams" | undefined>()
              expectTypeOf(chat?.user?.email).toEqualTypeOf<string | undefined>()
              return "customer"
            },
            scopes: {
              customer: {
                grants: [
                  { source: "forecastingEngine" },
                  { sources: ["docs"] },
                ],
              },
            },
          },
        }),
        supportChat,
      ],
      model: {} as never,
      workspace: {
        sources: {
          docs: source.file("AGENTS.md"),
          forecastingEngine: source.github({ repo: "acme/forecasting-engine" }),
        },
      },
    })

    // @ts-expect-error access source grants are checked against defineAgent({ workspace.sources })
    defineAgent({
      capabilities: [
        access({
          workspace: {
            scopes: {
              customer: { source: "missing" },
            },
          },
        }),
      ],
      model: {} as never,
      workspace: {
        sources: {
          docs: source.file("AGENTS.md"),
        },
      },
    })
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
