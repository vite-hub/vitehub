import { describe, expectTypeOf, it } from "vitest"

import { defineAgent, defineAgentInvoker, type AgentChannelDefinition, type AgentDriver, type AgentInvoker, type AgentMessageChannelSettings, type AgentRunInput, type AgentRuntimeConfig, type AgentRuntimeContext } from "../src/index.ts"
import { access, blob, chat, chatTitle, db, fetch, getTranscriptionResults, inputCommands, kv, mcp, repositoryHost, sandbox, schedule, skills, subagents, transcribe, webSearch, workspaceShell, type SubagentToolInput } from "../src/capabilities.ts"
import { http, teams, webChat } from "../src/channels.ts"
import { defineEval, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import type { AgentChatFinishExtension, AgentInvocationContextStore, AgentInvokerProfile, AgentUsageRecord } from "../src/index.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import { source } from "@vite-hub/workspace"
import type { AccessInvocationContextValue, AccessWorkspaceOptionsFor, AgentChatPlatformResolver, AgentChatRunContext, FetchCapabilityToolOptions, RepositoryHostClient, TranscriptionResult } from "../src/capabilities.ts"

describe("agent public types", () => {
  it("accepts capabilities from the capabilities entry", () => {
    defineAgent({
      capabilities: [
        access({
          chat: {
            resolve({ invoker, provider }) {
              expectTypeOf(invoker?.id).toEqualTypeOf<string | undefined>()
              expectTypeOf(provider).toEqualTypeOf<string>()
              return true
            },
          },
        }),
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
        repositoryHost({
          client: ({ invoker }) => {
            expectTypeOf(invoker.id).toEqualTypeOf<string>()
            return {
              provider: "github",
              read(request) {
                expectTypeOf(request.operation).toEqualTypeOf<"repository" | "changeRequests" | "changeRequest" | "changeRequestFiles" | "issues" | "issue" | "comments" | "checks" | "statuses">()
                expectTypeOf(request.target.repository).toEqualTypeOf<string>()
                return request
              },
              write(request) {
                expectTypeOf(request.operation).toEqualTypeOf<"comment" | "reaction">()
                return request
              },
            } satisfies RepositoryHostClient
          },
          mode: "write",
          policy: "require-approval",
          provider: "github",
        }),
        skills(),
        skills({ shellExecution: "read" }),
        skills({ shellExecution: "write" }),
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

    // @ts-expect-error skills shell execution mode must be read or write
    skills({ shellExecution: "allow" })

    const invocationContext: AgentInvocationContextStore = {
      entries: () => new Map<string, unknown>().entries(),
      get: () => undefined,
      has: () => false,
      set: () => undefined,
      toJSON: () => ({}),
    }
    expectTypeOf(invocationContext.get("access")).toEqualTypeOf<AccessInvocationContextValue | undefined>()
    expectTypeOf(invocationContext.get("access")?.workspaceScope?.scope).toEqualTypeOf<string | undefined>()
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
          expectTypeOf(event.extensions.get<AgentChatFinishExtension>("chat")).toEqualTypeOf<AgentChatFinishExtension | undefined>()
          expectTypeOf(event.extensions.get<TranscriptionResult[]>("transcribe")).toEqualTypeOf<TranscriptionResult[] | undefined>()
          expectTypeOf(event.extensions.get<AgentUsageRecord>("usage-telemetry")).toEqualTypeOf<AgentUsageRecord | undefined>()
          expectTypeOf(event.extensions.get<string>("usage-telemetry", "transcription")).toEqualTypeOf<string | undefined>()
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
      // @ts-expect-error model call settings belong under modelExecution.callSettings
      temperature: 0.2,
    })

    defineAgent({
      model: {} as never,
      // @ts-expect-error adapterOptions was removed; use modelExecution
      adapterOptions: {
        temperature: 0.2,
      },
    })

    defineAgent({
      model: {} as never,
      modelExecution: {
        callSettings: {
          temperature: 0.2,
        },
        instrumentation: {
          callSettings({ callSettings, input }) {
            expectTypeOf(callSettings).toEqualTypeOf<Readonly<Record<string, unknown>>>()
            expectTypeOf(input.messages).toEqualTypeOf<AgentRunInput["messages"]>()
            return {
              temperature: callSettings.temperature,
            }
          },
          model({ model }) {
            expectTypeOf(model).toEqualTypeOf<unknown>()
            return model
          },
        },
        stepLimit: 3,
        workspaceFallback: {
          enabled: true,
          maxToolResults: 2,
        },
      },
    })

    defineAgent({
      driver: {
        execution: {
          callSettings: {
            temperature: 0.2,
          },
          instrumentation: {
            callSettings({ callSettings, input }) {
              expectTypeOf(callSettings).toEqualTypeOf<Readonly<Record<string, unknown>>>()
              expectTypeOf(input.messages).toEqualTypeOf<AgentRunInput["messages"]>()
              return {
                temperature: callSettings.temperature,
              }
            },
            model({ model }) {
              expectTypeOf(model).toEqualTypeOf<unknown>()
              return model
            },
          },
        },
        instructions({ invoker }) {
          expectTypeOf(invoker.id).toEqualTypeOf<string>()
          return "Answer from the driver."
        },
        model: {} as never,
      },
    })

    defineAgent({
      driver: {
        credentials: { label: "local Codex", source: "ambient" },
        harness: { provider: "codex" },
        sandbox({ input }) {
          expectTypeOf(input.prompt).toEqualTypeOf<AgentRunInput["prompt"]>()
          return {}
        },
      },
    })

    // @ts-expect-error Agent Driver variants are mutually exclusive
    const _mixedDriver: AgentDriver = { model: "model", run: () => "ok" }

    // @ts-expect-error harness permissions are intentionally not public in V1
    const _permissionDriver: AgentDriver = { harness: { provider: "codex" }, permissions: "bypass" }

    // @ts-expect-error raw harness credential material is not accepted by the generic driver boundary
    const _rawCredentialDriver: AgentDriver = { credentials: { value: "secret" }, harness: { provider: "codex" } }

    // @ts-expect-error Agent Driver is not parameterized by Workspace Name
    type _agentDriverNoWorkspaceNameGeneric = AgentDriver<AgentRuntimeConfig, unknown, "docs">

    // @ts-expect-error root model options cannot be combined with driver
    defineAgent({ driver: { model: "model" }, model: "model" })

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

  it("accepts message settings and channels from the Agent Definition", () => {
    const messages: AgentMessageChannelSettings = {
      concurrency: "queue",
      history: { maxMessages: 20, source: "thread" },
      sessions: true,
    }
    const channel: AgentChannelDefinition = teams()
    expectTypeOf(channel.kind).toEqualTypeOf<string>()

    defineAgent({
      channels: {
        portal: http({
          adapter: () => ({}) as never,
          webhooks: { path: "/api/support/chat" },
        }),
        teams: teams({
          adapter: () => ({}) as never,
        }),
        web: webChat(),
      },
      messages,
      run: () => "ok",
    })

    defineAgent({
      channels: {
        web: webChat({
          messages: { history: false },
        }),
      },
      run: () => "ok",
    })

    type RootAgentExports = typeof import("../src/index.ts")
    // @ts-expect-error Channel Kind helpers are imported from @vite-hub/agent/channels, not the root entry.
    type _RootTeams = RootAgentExports["teams"]

    type ChannelExports = typeof import("../src/channels.ts")
    type _PublicTeams = ChannelExports["teams"]
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
      "portal" | "teams",
      { customer?: string, email?: string }
    >
    const workspaceAccess: AccessWorkspaceOptionsFor<typeof workspace, ChatContext> = {
      defaultScope: "customer",
      resolve({ input }) {
        const chat = input.get().context?.chat
        expectTypeOf(chat?.message?.metadata?.quiver?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.meta?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.meta?.email).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.run?.origin).toEqualTypeOf<"portal" | "teams" | undefined>()
        expectTypeOf(chat?.user?.email).toEqualTypeOf<string | undefined>()
        return chat?.user?.email?.endsWith("@quiver.dk")
          ? { instructions: "Use the internal support tone.", role: "admin", scope: "quiver" }
          : "customer"
      },
      scopes: {
        customer: {
          instructions: ["Use the customer support tone."],
          grants: [
            { path: "AGENTS.md" },
            { source: "forecastingEngine" },
            { sources: ["docs"] },
          ],
        },
        quiver: { all: true, instructions: "Use the internal support tone." },
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

  it("types Agent Invoker profiles and access source grants from defineAgent", () => {
    interface SupportMessageMetadata {
      quiver?: {
        customer?: string
      }
    }
    interface SupportChatUser {
      email?: string
    }
    const teamsAdapter = {} as AgentChatPlatformResolver
    const supportChat = chat({
      identity: ({ adapter, author }) => `${adapter}:${author.userId}`,
      platforms: () => ({ teams: teamsAdapter }),
      transcripts: {
        maxPerUser: 50,
        retention: "30d",
      },
    })
    chat({
      // @ts-expect-error adapters was removed; public Chat config uses platforms
      adapters: () => ({ teams: teamsAdapter }),
    })
    const workspace = {
      sources: {
        docs: source.file("AGENTS.md"),
        forecastingEngine: source.github({ repo: "acme/forecasting-engine" }),
      },
    }
    type SupportInvoker = AgentInvoker<{ audience?: "support" | "technical", customer?: "acme" }>
    type SupportInputContext = AgentChatRunContext<SupportMessageMetadata, SupportChatUser, "teams"> & {
      invoker?: SupportInvoker
    }
    const supportProfiles: readonly AgentInvokerProfile<{ audience?: "technical", customer?: "acme" }>[] = [
      { id: "support-customer", kind: "customer", meta: { customer: "acme" } },
      { id: "support-technical", kind: "technical", meta: { audience: "technical" } },
    ]
    expectTypeOf(supportProfiles[0]?.meta?.customer).toEqualTypeOf<"acme" | undefined>()
    expectTypeOf({} as AgentRunInput<unknown, SupportInputContext>["context"]).toEqualTypeOf<SupportInputContext | undefined>()
    type BrowserSubagentContext = { previewUrl: string }
    const browserAgentInput: AgentRunInput<{ mode: "fast" }, BrowserSubagentContext> = {
      context: { previewUrl: "https://preview.local" },
      message: "Check the product card.",
      options: { mode: "fast" },
    }
    expectTypeOf(browserAgentInput.context?.previewUrl).toEqualTypeOf<string | undefined>()
    expectTypeOf(browserAgentInput.options?.mode).toEqualTypeOf<"fast" | undefined>()
    const browserToolInput: SubagentToolInput<{ mode: "fast" }, BrowserSubagentContext> = {
      context: { previewUrl: "https://preview.local" },
      message: "Check the product card.",
      options: { mode: "fast" },
      runId: "review-run:browser",
    }
    expectTypeOf(browserToolInput.runId).toEqualTypeOf<string | undefined>()
    subagents({
      agents: {
        browser: {
          agent: defineAgent({ run: () => "ok" }),
          description: "Collect browser evidence.",
        },
      },
    })
    const supportAccess: AccessWorkspaceOptionsFor<typeof workspace, SupportInputContext> = {
      resolve({ input, invoker }) {
        const chat = input.get().context?.chat
        expectTypeOf(chat?.message?.metadata?.quiver?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.run?.origin).toEqualTypeOf<"teams" | undefined>()
        expectTypeOf(chat?.user?.email).toEqualTypeOf<string | undefined>()
        expectTypeOf(invoker.id).toEqualTypeOf<string>()
        expectTypeOf(invoker.meta?.customer).toEqualTypeOf<"acme" | undefined>()
        return invoker.meta?.customer || "customer"
      },
      scopes: {
        customer: {
          grants: [
            { source: "forecastingEngine" },
            { sources: ["docs"] },
          ],
        },
      },
    }

    defineAgent({
      workspace,
      run() {
        return "ok"
      },
      invoker: defineAgentInvoker({
        profiles: supportProfiles,
        resolve({ defaultInvoker, input, profiles, run, selectedProfile }) {
          expectTypeOf(defaultInvoker.id).toEqualTypeOf<string>()
          expectTypeOf(input.messages).toEqualTypeOf<AgentRunInput["messages"]>()
          expectTypeOf(profiles).toEqualTypeOf<typeof supportProfiles>()
          expectTypeOf(run?.origin).toEqualTypeOf<string | undefined>()
          expectTypeOf(run?.runId).toEqualTypeOf<string | undefined>()
          expectTypeOf(selectedProfile?.meta?.customer).toEqualTypeOf<"acme" | undefined>()
          return selectedProfile || defaultInvoker
        },
      }),
      capabilities: [
        access({
          workspace: supportAccess,
        }),
        supportChat,
      ],
      model: {} as never,
    })

    defineAgent({
      workspace,
      capabilities: [
        access({
          workspace: {
            defaultScope: "quiver",
            scopes: {
              demo: { source: "docs" },
              quiver: { all: true },
            },
          },
        }),
      ],
      run({ context }) {
        const accessContext = context.get("access")
        expectTypeOf(accessContext).toMatchTypeOf<AccessInvocationContextValue<"demo" | "quiver"> | undefined>()
        expectTypeOf(accessContext?.workspaceScope?.scope).toEqualTypeOf<"demo" | "quiver" | undefined>()
        expectTypeOf(accessContext?.workspaceScope?.paths).toEqualTypeOf<string[] | undefined>()
        return "ok"
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

  it("types Agent Invoker consumers in access and lifecycle callbacks", () => {
    defineAgent({
      invoker: {
        profiles: [
          { id: "quiver-technical", kind: "quiverTechnical", meta: { customer: "acme" } },
        ],
      },
      capabilities: [
        access({
          workspace: {
            resolve({ invoker }) {
              expectTypeOf(invoker.kind).toEqualTypeOf<"anonymous" | "chat" | "devtools" | (string & {}) | undefined>()
              return invoker.kind === "quiverTechnical"
                ? { role: "admin", scope: "quiver" }
                : { role: "viewer", scope: "acme" }
            },
            scopes: {
              acme: { source: "docs" },
              quiver: { all: true },
            },
          },
        }),
        {
          id: "support-audience",
          prepare({ instructions, invoker }) {
            expectTypeOf(invoker.id).toEqualTypeOf<string>()
            instructions.add(invoker.kind === "quiverTechnical" ? "technical" : "customer")
          },
        },
      ],
      hooks: {
        "agent:finish"({ invoker }) {
          expectTypeOf(invoker.meta).toEqualTypeOf<Record<string, unknown> | undefined>()
        },
      },
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
      runtime: "vite",
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
