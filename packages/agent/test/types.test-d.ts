import { describe, expectTypeOf, it } from "vitest"

import { defineAgent, defineAgentInvoker, defineCapability, type AgentActor, type AgentCapabilityCliCommand, type AgentCapabilityDefinition, type AgentChannelDeliveryEffectContext, type AgentChannelDeliveryEffectIntent, type AgentChannelDeliveryEffectKind, type AgentChannelDeliveryFinishEffect, type AgentChannelDeliveryFinishEffectContext, type AgentChannelDefinition, type AgentDeliveryArtifact, type AgentDriver, type AgentHookObserverEvent, type AgentInvoker, type AgentMessageChannelSettings, type AgentRunInput, type AgentRunInputContextValues, type AgentRuntimeConfig, type AgentRuntimeContext, type PublishedAgentDeliveryArtifact } from "../src/index.ts"
import { access, blob, chat, chatTitle, db, fetch, getTranscriptionResults, git, inputCommands, kv, mcp, observability, openapi, pullRequestContext, repositoryHost, sandbox, schedule, skills, subagents, transcribe, usageTelemetry, webSearch, workspaceShell, type SubagentToolInput } from "../src/capabilities.ts"
import { defineChannel, github, http, stream, teams, telegram, webChat, type GitHubPullRequestCommand, type GitHubPullRequestRunContext } from "../src/channels.ts"
import { defineEval, hasCapabilityExtension, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import { streamAgentOutputToEvents, toAgentRunResult } from "../src/output.ts"
import type { AgentChatFinishExtension, AgentInvocationContextStore, AgentInvokerProfile, AgentOutputExtensionProvider, AgentUsageRecord, StreamEvent } from "../src/index.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import { fetch as fetchSource, file, github as githubSource } from "@vite-hub/workspace"
import type { AccessInvocationContextValue, AccessWorkspaceOptionsFor, AgentChatPlatformResolver, AgentChatRunContext, FetchCapabilityToolOptions, PullRequestContextValue, RepositoryHostClient, TranscriptionResult, UsageTelemetryOutputExtension, UsageTelemetrySummaryOptions } from "../src/capabilities.ts"

describe("agent public types", () => {
  it("accepts capabilities from the capabilities entry", () => {
    const openAPISpec = {
      paths: {
        "/customers": {
          get: {
            operationId: "listCustomers",
          },
        },
      },
      servers: [{ url: "https://api.example.com" }],
    }

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
        openapi({
          operations: ["listCustomers"],
          hooks: {
            request({ context, operation, request }) {
              expectTypeOf(context.get<{ token: string }>("billing")?.token).toEqualTypeOf<string | undefined>()
              expectTypeOf(operation.id).toEqualTypeOf<string>()
              expectTypeOf(request.headers).toEqualTypeOf<Headers>()
              request.headers.set("authorization", "Bearer token")
              return { query: { region: "eu" } }
            },
          },
          spec: openAPISpec,
          transformResponse(response, { request }) {
            expectTypeOf(response).toEqualTypeOf<unknown>()
            expectTypeOf(request.headers).toEqualTypeOf<Headers>()
            return response
          },
        }),
        openapi({
          operations: ["listCustomers"],
          hooks: {
            request: {
              provides: {
                query: ["region"],
              },
              handler({ request }) {
                request.query.region = "eu"
                return { headers: { authorization: "Bearer token" } }
              },
            },
          },
          spec: openAPISpec,
        }),
        git(),
        git({ mode: "read" }),
        git({ mode: "write", policy: "require-approval" }),
        workspaceShell({ commands: ["agent-browser", "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"] }),
        workspaceShell({ commands: ["agent-browser"], mode: "read", timeout: 1_000 }),
        workspaceShell({ commands: ["agent-browser"], mode: "write" }),
        inputCommands({
          commands: {
            review: {
              description: "Review the request.",
              call: ({ args }) => `review:${args}`,
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
        pullRequestContext({
          context: {
            number: 12,
            repository: "acme/app",
          } satisfies PullRequestContextValue,
          rules: {
            "artifacts/review/**": { write: true },
          },
          sources: {
            pullRequest: file({ mount: "pull-request", path: "README.md" }),
          },
        }),
        skills(),
        skills({ path: "skills/agent-browser", source: githubSource({ repo: "vercel/vercel-plugin", root: "skills/agent-browser" }) }),
        skills({ path: "skills/agent-browser", shellExecution: "write", source: githubSource({ repo: "vercel/vercel-plugin", root: "skills/agent-browser" }) }),
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
        usageTelemetry({ summary: true }),
        usageTelemetry({ summary: { subject: "Review run" } satisfies UsageTelemetrySummaryOptions }),
        usageTelemetry({
          summary: {
            format(record, { subject }) {
              expectTypeOf(record.usage?.totalTokens).toEqualTypeOf<number | undefined>()
              expectTypeOf(subject).toEqualTypeOf<string>()
              return "usage"
            },
          },
        }),
        observability({
          instrumentation: {
            callSettings({ callSettings, run }) {
              expectTypeOf(callSettings).toEqualTypeOf<Readonly<Record<string, unknown>>>()
              expectTypeOf(run?.runId).toEqualTypeOf<string | undefined>()
            },
            model({ model }) {
              expectTypeOf(model).toEqualTypeOf<unknown>()
              return model
            },
          },
          onEvent(event) {
            expectTypeOf(event.type).toEqualTypeOf<"error" | "finish" | "start">()
            if (event.type === "error") {
              expectTypeOf(event.error).toEqualTypeOf<unknown>()
              expectTypeOf(event.status).toEqualTypeOf<"failed">()
            }
          },
          usageTelemetry: { summary: true },
        }),
        observability({ usageTelemetry: false }),
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
            expectTypeOf(input.context).toEqualTypeOf<AgentRunInputContextValues | undefined>()
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
      driver: { model: {} as never },
      workspace: { mode: "read" },
    })

    defineAgent({
      driver: {
        harness: { provider: "codex" },
      },
      harnessSandbox: ({ input }) => {
        expectTypeOf(input.prompt).toEqualTypeOf<AgentRunInput["prompt"]>()
        return { providerId: "local-test" }
      },
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

    // @ts-expect-error skills delegates shell options to Workspace Shell tools
    skills({ shellExecution: "read", timeout: 1000 })

    // @ts-expect-error OpenAPI Capability attachment is the opt-in; use access or Agent Trigger policy instead
    openapi({ enabled: true, operations: ["listCustomers"], spec: openAPISpec })

    // @ts-expect-error use operations as the direct operationId allowlist
    openapi({ operations: { allow: ["listCustomers"] }, spec: openAPISpec })

    // @ts-expect-error use hooks.request for host-supplied request values
    openapi({ defaults: { body: { token: "secret" } }, operations: ["listCustomers"], spec: openAPISpec })

    // @ts-expect-error OpenAPI request preparation uses hooks.request
    openapi({ operations: ["listCustomers"], request: () => undefined, spec: openAPISpec })

    // @ts-expect-error use server only as the explicit server override
    openapi({ baseUrl: "https://api.example.com", operations: ["listCustomers"], spec: openAPISpec })

    // @ts-expect-error git mode must be read or write
    git({ mode: "remote-write" })

    // @ts-expect-error workspaceShell mode must be read or write
    workspaceShell({ commands: ["agent-browser"], mode: "execute" })

    // @ts-expect-error workspaceShell timeout must be a number
    workspaceShell({ commands: ["agent-browser"], timeout: "1000" })

    // @ts-expect-error sandbox requires commands
    sandbox({})

    const invocationContext: AgentInvocationContextStore = {
      entries: () => new Map<string, unknown>().entries(),
      get: () => undefined,
      has: () => false,
      set: () => undefined,
      toJSON: () => ({}),
    }
    expectTypeOf(invocationContext.get("access")).toEqualTypeOf<AccessInvocationContextValue | undefined>()
    expectTypeOf(invocationContext.get("access")?.workspaceScope?.scope).toEqualTypeOf<string | undefined>()
    expectTypeOf(invocationContext.get("actor")).toEqualTypeOf<AgentActor | undefined>()
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
      driver: { model: {} as never },
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
      driver: { model: {} as never },
      hooks: {
        "agent:finish"(event) {
          expectTypeOf(event.extensions.get<AgentChatFinishExtension>("chat")).toEqualTypeOf<AgentChatFinishExtension | undefined>()
          expectTypeOf(event.extensions.get<TranscriptionResult[]>("transcribe")).toEqualTypeOf<TranscriptionResult[] | undefined>()
          expectTypeOf(event.extensions.get<AgentUsageRecord>("usage-telemetry")).toEqualTypeOf<AgentUsageRecord | undefined>()
          expectTypeOf(event.errorMessage).toEqualTypeOf<string | undefined>()
        },
      },
    })

    defineAgent({
      capabilities: [{
        id: "finish-extension",
        finish(event) {
          expectTypeOf(event.extensions.get("finish-extension")).toEqualTypeOf<unknown>()
          expectTypeOf(event.result).toEqualTypeOf<unknown>()
          return "ok"
        },
        output(context) {
          context.finish.provide("ok")
          // @ts-expect-error finish extensions are registered through context.finish
          context.extensions.provide("agent:finish", "ok")
        },
      }],
      driver: { model: {} as never },
    })

    defineAgent({
      capabilities: [{
        id: "output-extension",
        output(context) {
          context.output.provide({ summary: "ok" })
          context.output.provide(((event) => {
            expectTypeOf(event.result).toEqualTypeOf<unknown>()
            expectTypeOf(event.extensions.get("output-extension")).toEqualTypeOf<unknown>()
            return { summary: "ok" }
          }) satisfies AgentOutputExtensionProvider)
          context.output.render((result, renderContext) => {
            expectTypeOf(renderContext.output.extensions.get<{ summary: string }>("output-extension")).toEqualTypeOf<{ summary: string } | undefined>()
            expectTypeOf(renderContext.output.extensions.get<string>("output-extension", "summary")).toEqualTypeOf<string | undefined>()
            expectTypeOf(renderContext.output.extensions.get<UsageTelemetryOutputExtension>("usage-telemetry")).toEqualTypeOf<UsageTelemetryOutputExtension | undefined>()
            return result
          })
          context.output.final((result, renderContext) => {
            expectTypeOf(renderContext.output.extensions.get<{ summary: string }>("output-extension")).toEqualTypeOf<{ summary: string } | undefined>()
            return result
          })
        },
      }],
      driver: { model: {} as never },
    })

    defineAgent({
      driver: { model: {} as never },
      // @ts-expect-error root-level tools are not public API
      tools: {},
    })

    defineAgent({
      driver: { model: {} as never },
      // @ts-expect-error workspace mode must be read or write
      workspace: { mode: "mutable" },
    })

    defineAgent({
      driver: { model: {} as never },
      workspace: "review",
    })

    defineAgent({
      capabilities: [workspaceShell({ mode: "write" })],
      driver: { model: {} as never },
      workspace: { name: "review", mode: "write" },
    })

    // @ts-expect-error workspace reference mode must be read or write
    defineAgent({
      driver: { model: {} as never },
      workspace: { name: "review", mode: "mutable" },
    })

    // @ts-expect-error named workspace references cannot include colocated Workspace Definition options
    defineAgent({
      driver: { model: {} as never },
      workspace: { name: "review", sources: {} },
    })

    defineAgent({
      driver: { model: {} as never },
      // @ts-expect-error model call settings belong under driver.execution.callSettings
      temperature: 0.2,
    })

    defineAgent({
      driver: { model: {} as never },
      // @ts-expect-error adapterOptions was removed; use driver.execution
      adapterOptions: {
        temperature: 0.2,
      },
    })

    defineAgent({
      driver: {
        model: {} as never,
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
          stepLimit: 3,
          workspaceFallback: {
            enabled: true,
            maxToolResults: 2,
          },
        }
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
        harness({ input }) {
          expectTypeOf(input.prompt).toEqualTypeOf<AgentRunInput["prompt"]>()
          return { provider: "codex" }
        },
      },
    })

    // @ts-expect-error Agent Driver variants are mutually exclusive
    const _mixedDriver: AgentDriver = { model: "model", run: () => "ok" }

    // @ts-expect-error raw harness permissions are intentionally not public in V1
    const _permissionDriver: AgentDriver = { harness: { provider: "codex" }, permissions: "bypass" }

    // @ts-expect-error harness permission mode is runtime policy, not a public Agent Driver option
    const _permissionModeDriver: AgentDriver = { harness: { provider: "codex" }, permissionMode: "allow-edits" }

    // @ts-expect-error harness sandbox setup is runtime plumbing, not a public Agent Driver option
    const _sandboxDriver: AgentDriver = { harness: { provider: "codex" }, sandbox: { provider: "sandbox" } }

    // @ts-expect-error raw harness credential material is not accepted by the generic driver boundary
    const _rawCredentialDriver: AgentDriver = { credentials: { value: "secret" }, harness: { provider: "codex" } }

    // @ts-expect-error Agent Driver is not parameterized by Workspace Name
    type _agentDriverNoWorkspaceNameGeneric = AgentDriver<AgentRuntimeConfig, unknown, "docs">

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
    // @ts-expect-error app-owned ingress belongs to Channels, not entry()
    type _PublicEntry = CapabilityExports["entry"]
    // @ts-expect-error Access Capability Type Contract is internal to access() inference
    type _PublicAccessCapabilityTypeContract = CapabilityExports["AccessCapabilityTypeContract"]
    // @ts-expect-error transcription extension inference is internal, not public capabilities API
    type _PublicAudioExtensionFor = CapabilityExports["audioExtensionFor"]
    // @ts-expect-error transcription context storage key is internal, not public capabilities API
    type _PublicTranscriptionContextKey = CapabilityExports["TRANSCRIPTION_RESULTS_CONTEXT_KEY"]
  })

  it("accepts flat Capability CLI contributions", () => {
    const inputSchema = {
      "~standard": {
        validate: (input: unknown) => ({ value: input as { limit?: number } }),
      },
    }
    const outputSchema = {
      "~standard": {
        validate: (input: unknown) => ({ value: input as { items: string[] } }),
      },
    }
    const listItems = {
      description: "List inventory items for the current application context.",
      effects: ["read", "network:inventory"],
      input: inputSchema,
      output: { format: "json", schema: outputSchema },
      async run({ context, input, json }) {
        expectTypeOf(context.capability.id).toEqualTypeOf<string>()
        expectTypeOf(input).toEqualTypeOf<{ limit?: number }>()
        expectTypeOf(json).toEqualTypeOf<boolean>()
        return { items: [] }
      },
    } satisfies AgentCapabilityCliCommand<AgentRuntimeConfig, string, { limit?: number }, { items: string[] }>

    const inventoryRuntime = defineCapability({
      id: "inventory-runtime",
      cli: {
        name: "inventory",
        description: "Inspect live inventory data.",
        commands: {
          items: {
            description: "Inventory item data.",
            commands: {
              list: listItems,
            },
          },
        },
      },
    })

    expectTypeOf(inventoryRuntime.cli?.commands).toMatchTypeOf<Record<string, AgentCapabilityCliCommand> | undefined>()
    const audioRuntime = defineCapability({
      chatAttachments: { audio: true },
      id: "audio-runtime",
    })
    expectTypeOf(audioRuntime.chatAttachments).toMatchTypeOf<{ audio?: boolean } | undefined>()

    defineCapability({
      id: "legacy-instructions",
      // @ts-expect-error Capability instructions were removed from Capability definitions.
      instructions: "Use inventory only for runtime data.",
    })
    defineCapability({
      id: "dynamic-inventory-runtime",
      // @ts-expect-error Capability CLI contributions are flat objects, not resolver functions
      cli: () => ({
        commands: {
          list: {
            run: () => ({ items: [] }),
          },
        },
        name: "inventory",
      }),
    })
    type RootAgentExports = typeof import("../src/index.ts")
    // @ts-expect-error Capability CLI builders are not root Agent Package exports
    type _RootCliBuilder = RootAgentExports["cli"]
    // @ts-expect-error Capability CLI command builders are not root Agent Package exports
    type _RootCommandBuilder = RootAgentExports["command"]
  })

  it("accepts message settings and channels from the Agent Definition", () => {
    const messages: AgentMessageChannelSettings = {
      concurrency: "queue",
      sessions: true,
      triggerHistory: { maxMessages: 20, source: "thread" },
    }
    const channel: AgentChannelDefinition = teams()
    expectTypeOf(channel.kind).toEqualTypeOf<string>()
    const reviewFinishEffect: AgentChannelDeliveryFinishEffect = event => ({
      kind: "reply",
      payload: event.result,
    })
    // @ts-expect-error Development samples belong in CLI payload files, not Channel options.
    teams({ dev: { samples: {} } })
    // @ts-expect-error Development samples belong in CLI payload files, not Channel Definitions.
    defineChannel("portal", { dev: { samples: {} } })
    const custom = defineChannel("portal", {
      effects: {
        reaction(context) {
          expectTypeOf(context.effect.kind).toEqualTypeOf<AgentChannelDeliveryEffectKind>()
          expectTypeOf(context.effect).toEqualTypeOf<AgentChannelDeliveryEffectIntent>()
          expectTypeOf(context.effect.artifacts?.[0]).toEqualTypeOf<PublishedAgentDeliveryArtifact | undefined>()
          expectTypeOf(context.workspace).toEqualTypeOf<AgentChannelDeliveryEffectContext["workspace"]>()
        },
      },
      messages: false,
      triggers: {
        event: {
          invoke(context, input: { text: string }) {
            expectTypeOf(context.channel.kind).toEqualTypeOf<string>()
            expectTypeOf(context.trigger.channelId).toEqualTypeOf<string>()
            expectTypeOf(input.text).toEqualTypeOf<string>()
            return {
              delivery: {
                finishEffects: (event, context) => {
                  expectTypeOf(context.workspace).toEqualTypeOf<AgentChannelDeliveryFinishEffectContext["workspace"]>()
                  return {
                    artifacts: [{ path: "screenshots/result.png", url: "https://assets.example/result.png" }],
                    kind: "reply",
                    payload: event.result,
                  }
                },
              },
              input: { prompt: input.text },
            }
          },
        },
      },
    })
    expectTypeOf(custom.kind).toEqualTypeOf<string>()
    expectTypeOf<AgentDeliveryArtifact>().toMatchTypeOf<{ path: string }>()

    defineAgent({
      capabilities: [{
        id: "feedback",
        prepare(context) {
          context.delivery.effect({ intent: "started", kind: "reaction" })
          context.delivery.finishEffect(event => ({ kind: "reply", payload: event.result }))
        },
      }, inputCommands({
        commands: {
          review: {
            channels: ["github"],
            description: "Review the pull request.",
            call({ args, input }) {
              expectTypeOf(args).toEqualTypeOf<string>()
              expectTypeOf(input.context?.github).toEqualTypeOf<GitHubPullRequestCommand | undefined>()
              const pullRequest = input.context?.pullRequest
              expectTypeOf(pullRequest).toEqualTypeOf<GitHubPullRequestRunContext | undefined>()
              return { prompt: args }
            },
            hooks: {
              async "agent:input"(context) {
                await context.message.react("eyes", { transient: true })
              },
              async "agent:finish"(context) {
                if (context.error) await context.message.reply("failed")
              },
            },
          },
        },
      })],
      channels: {
        github: github({
          app: true,
          events: {
            pullRequestComments: {
              origin: "github-review",
              reply: reviewFinishEffect,
            },
          },
        }),
        portal: http({
          adapter: () => ({}) as never,
          webhooks: { path: "/api/support/chat" },
        }),
        teams: teams({
          adapter: () => ({}) as never,
        }),
        telegram: telegram({
          adapter: () => ({}) as never,
        }),
        portalStream: stream({
          route: {
            mapInput({ body, request }) {
              expectTypeOf(body.messages).toEqualTypeOf<unknown>()
              expectTypeOf(request).toEqualTypeOf<Request>()
              return { meta: body.meta as Record<string, unknown> }
            },
          },
        }),
        web: webChat({
          route: {
            admission: {
              body: {
                "~standard": {
                  validate: (input: unknown) => ({
                    value: input as { messages: unknown[], meta: { customer: string }, user: { email: string } },
                  }),
                },
              },
              authenticate({ body, rawBody, request }) {
                expectTypeOf(body.messages).toEqualTypeOf<unknown>()
                expectTypeOf(rawBody).toEqualTypeOf<string>()
                expectTypeOf(request).toEqualTypeOf<Request>()
                return { invokerProfileId: "customer:acme" }
              },
              context({ auth, body, rawBody }) {
                expectTypeOf(auth.invokerProfileId).toEqualTypeOf<string>()
                expectTypeOf(body.meta.customer).toEqualTypeOf<string>()
                expectTypeOf(body.user.email).toEqualTypeOf<string>()
                expectTypeOf(rawBody).toEqualTypeOf<string>()
                return {
                  invokerProfileId: auth.invokerProfileId,
                  meta: body.meta,
                  user: body.user,
                }
              },
            },
            input: {
              trust: ["meta", "user", "session"],
            },
          },
        }),
      },
      hooks: {
        "hook:observe"(event) {
          expectTypeOf(event).toEqualTypeOf<Readonly<AgentHookObserverEvent>>()
        },
      },
      messages,
      driver: { run: () => "ok" },
    })

    defineAgent({
      channels: {
        web: webChat({
          messages: { triggerHistory: "none" },
        }),
      },
      driver: { run: () => "ok" },
    })

    defineAgent({
      // @ts-expect-error custom-run-backed Agent Drivers do not receive model-facing instructions
      driver: { instructions: "ignored", run: () => "ok" },
    })

    type RootAgentExports = typeof import("../src/index.ts")
    // @ts-expect-error Channel Kind helpers are imported from @vite-hub/agent/channels, not the root entry.
    type _RootTeams = RootAgentExports["teams"]
    // @ts-expect-error defineChannel is imported from @vite-hub/agent/channels, not the root entry.
    type _RootDefineChannel = RootAgentExports["defineChannel"]
    // @ts-expect-error Channel Kind helpers are imported from @vite-hub/agent/channels, not the root entry.
    type _RootTelegram = RootAgentExports["telegram"]
    // @ts-expect-error Channel Kind helpers are imported from @vite-hub/agent/channels, not the root entry.
    type _RootStream = RootAgentExports["stream"]

    type ChannelExports = typeof import("../src/channels.ts")
    type _PublicDefineChannel = ChannelExports["defineChannel"]
    type _PublicGithub = ChannelExports["github"]
    type _PublicStream = ChannelExports["stream"]
    type _PublicTelegram = ChannelExports["telegram"]
    type _PublicTeams = ChannelExports["teams"]

    type ServerExports = typeof import("../src/server.ts")
    // @ts-expect-error generated route handler factories are internal Provider Output plumbing.
    type _PublicChannelChatRouteHandler = ServerExports["createChannelChatRouteHandler"]
    // @ts-expect-error generated route handler factories are internal Provider Output plumbing.
    type _PublicChannelWebhookRouteHandler = ServerExports["createChannelWebhookRouteHandler"]
    // @ts-expect-error generated route handler factories are internal Provider Output plumbing.
    type _PublicChannelDevtoolsRouteHandler = ServerExports["createChannelDevtoolsRouteHandler"]

    type InternalServerExports = typeof import("../src/server/internal.ts")
    type _InternalChannelChatRouteHandler = InternalServerExports["createChannelChatRouteHandler"]
  })

  it("types access workspace source grants and chat run context", () => {
    const workspace = {
      sources: {
        docs: file("AGENTS.md"),
        forecastingEngine: githubSource({ repo: "acme/forecasting-engine" }),
        pullRequest: githubSource(({ invocation }) => {
          const pullRequest = invocation.context.get("pullRequest")
          expectTypeOf(pullRequest).toEqualTypeOf<GitHubPullRequestRunContext | undefined>()
          if (!pullRequest) return false
          return {
            repo: pullRequest.pullRequest.source.repo,
            ref: pullRequest.pullRequest.source.ref,
            mount: pullRequest.pullRequest.source.mount,
          }
        }),
      },
    }
    type ChatContext = AgentChatRunContext<
      { quiver?: { customer?: string } },
      { email?: string },
      { customer?: string, email?: string }
    >
    const workspaceAccess: AccessWorkspaceOptionsFor<typeof workspace, ChatContext> = {
      defaultScope: "customer",
      resolve({ input, run }) {
        const chat = input.get().context?.chat
        expectTypeOf(chat?.message?.metadata?.quiver?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.meta?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.meta?.email).toEqualTypeOf<string | undefined>()
        expectTypeOf(run?.origin).toEqualTypeOf<string | undefined>()
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
    // @ts-expect-error Workspace Scope instructions were removed.
    access({
      workspace: {
        scopes: {
          acme: {
            instructions: "Use customer tone.",
            paths: ["AGENTS.md"],
          },
        },
      },
    })

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
        docs: file("AGENTS.md"),
        forecastingEngine: githubSource({ repo: "acme/forecasting-engine" }),
      },
    }
    type SupportInvoker = AgentInvoker<{ audience?: "support" | "technical", customer?: "acme" }>
    type SupportInputContext = AgentChatRunContext<SupportMessageMetadata, SupportChatUser> & {
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
          agent: defineAgent({           driver: {
            run: () => "ok"
          },
}),
          description: "Collect browser evidence.",
        },
      },
    })
    const supportAccess: AccessWorkspaceOptionsFor<typeof workspace, SupportInputContext> = {
      resolve({ actor, input, invoker, run }) {
        const chat = input.get().context?.chat
        expectTypeOf(chat?.message?.metadata?.quiver?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(run?.origin).toEqualTypeOf<string | undefined>()
        expectTypeOf(chat?.user?.email).toEqualTypeOf<string | undefined>()
        expectTypeOf(actor.id).toEqualTypeOf<string>()
        expectTypeOf(invoker.id).toEqualTypeOf<string>()
        expectTypeOf(invoker.meta?.customer).toEqualTypeOf<"acme" | undefined>()
        return actor.meta?.customer || "customer"
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
      driver: {
        run() {
          return "ok"
        },
        model: {} as never
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
      hooks: {
        "agent:input"({ context }) {
          const accessContext = context.get("access")
          expectTypeOf(accessContext).toMatchTypeOf<AccessInvocationContextValue<"demo" | "quiver"> | undefined>()
          expectTypeOf(accessContext?.workspaceScope?.scope).toEqualTypeOf<"demo" | "quiver" | undefined>()
        },
      },
      driver: { run({ actor, context }) {
          const accessContext = context.get("access")
          expectTypeOf(actor.id).toEqualTypeOf<string>()
          expectTypeOf(context.get("actor")).toEqualTypeOf<AgentActor | undefined>()
          expectTypeOf(accessContext).toMatchTypeOf<AccessInvocationContextValue<"demo" | "quiver"> | undefined>()
          expectTypeOf(accessContext?.workspaceScope?.scope).toEqualTypeOf<"demo" | "quiver" | undefined>()
          expectTypeOf(accessContext?.workspaceScope?.paths).toEqualTypeOf<string[] | undefined>()
          return "ok"
        } },
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
      driver: { model: {} as never },
      workspace: {
        sources: {
          docs: file("AGENTS.md"),
        },
      },
    })

    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "docs" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    // @ts-expect-error source-local scopes are checked against access workspace scope keys
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["missing"] as const }),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "docs" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    // @ts-expect-error unscoped sources do not disable Workspace Source scope checks
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["missing"] as const }),
          readme: file("README.md"),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "docs" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    const dynamicScopes: string[] = ["dynamic"]
    // @ts-expect-error broad source scopes do not disable literal Workspace Source scope checks
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["missing"] as const }),
          dynamic: githubSource({ repo: "acme/dynamic", scopes: dynamicScopes }),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "docs" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    defineAgent({
      workspace: {
        sources: {
          status: fetchSource({
            scopes: ["customer"] as const,
            transform(data: { status: string }) {
              return data
            },
            url: "https://status.example.com/api/summary",
            workspacePath: "status/summary.json",
          }),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "status" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    // @ts-expect-error typed fetch source scopes must be backed by Access Workspace Scopes
    defineAgent({
      workspace: {
        sources: {
          status: fetchSource({
            scopes: ["missing"] as const,
            transform(data: { status: string }) {
              return data
            },
            url: "https://status.example.com/api/summary",
            workspacePath: "status/summary.json",
          }),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "status" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    // @ts-expect-error concrete custom capabilities do not satisfy Workspace Source scopes
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      capabilities: [
        defineCapability({ id: "audit" }),
      ],
      driver: { model: {} as never },
    })

    // @ts-expect-error Workspace Source scopes require access({ workspace })
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      driver: { model: {} as never },
    })

    // @ts-expect-error non-Access capabilities do not satisfy Workspace Source scopes
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      capabilities: [
        workspaceShell(),
      ],
      driver: { model: {} as never },
    })

    const broadCapabilities: AgentCapabilityDefinition[] = [
      access({
        workspace: {
          defaultScope: "customer",
          scopes: {
            customer: { source: "docs" },
          },
        },
      }),
    ]

    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      capabilities: broadCapabilities,
      driver: { model: {} as never },
    })

    const widenedAccessCapability: AgentCapabilityDefinition = access({
      workspace: {
        defaultScope: "customer",
        scopes: {
          customer: { source: "docs" },
        },
      },
    })

    // @ts-expect-error individual widened capabilities cannot prove Access Workspace Scope names
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      capabilities: [widenedAccessCapability],
      driver: { model: {} as never },
    })

    // @ts-expect-error broad official capabilities do not satisfy missing Workspace Source scopes
    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["missing"] as const }),
        },
      },
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "docs" },
            },
          },
        }),
        blob(),
      ],
      driver: { model: {} as never },
    })

    const bundledAccessCapability = defineCapability({
      capabilities: [
        access({
          workspace: {
            defaultScope: "customer",
            scopes: {
              customer: { source: "docs" },
            },
          },
        }),
      ],
      id: "workspace-access-bundle",
    })

    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs", scopes: ["customer"] as const }),
        },
      },
      capabilities: [bundledAccessCapability],
      driver: { model: {} as never },
    })
  })

  it("types Agent Actor consumers in access and lifecycle callbacks", () => {
    defineAgent({
      invoker: {
        profiles: [
          { id: "quiver-technical", kind: "quiverTechnical", meta: { customer: "acme" } },
        ],
      },
      capabilities: [
        access({
          workspace: {
            resolve({ actor, invoker }) {
              expectTypeOf(actor.kind).toEqualTypeOf<"anonymous" | "chat" | "devtools" | (string & {}) | undefined>()
              expectTypeOf(invoker.kind).toEqualTypeOf<"anonymous" | "chat" | "devtools" | (string & {}) | undefined>()
              return actor.kind === "quiverTechnical"
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
          prepare({ actor, invoker }) {
            expectTypeOf(actor.id).toEqualTypeOf<string>()
            expectTypeOf(invoker.id).toEqualTypeOf<string>()
          },
        },
      ],
      hooks: {
        "agent:finish"({ actor, invoker }) {
          expectTypeOf(actor.meta).toEqualTypeOf<Record<string, unknown> | undefined>()
          expectTypeOf(invoker.meta).toEqualTypeOf<Record<string, unknown> | undefined>()
        },
      },
      driver: { model: {} as never },
      workspace: {
        sources: {
          docs: file("AGENTS.md"),
        },
      },
    })
  })

  it("accepts agent eval definitions", () => {
    const scorer: AgentScorer = textContains("ok")
    const capabilityScorer: AgentScorer = hasCapabilityExtension("observability")
    const definition: AgentEvalDefinition = {
      agent: defineAgent({
        driver: { model: {} as never },
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

    defineEval({
      agent: defineAgent({
        driver: { model: {} as never },
      }),
      async test(t) {
        const observation = await t.send("hello")
        observation.text.toUpperCase()
        expectTypeOf(observation.extensions?.get("observability")).toEqualTypeOf<unknown>()
        expectTypeOf(t.capabilityExtension<{ status: string }>("observability")).toEqualTypeOf<{ status: string } | undefined>()
        expectTypeOf(t.capabilityExtension<string>("observability", "status")).toEqualTypeOf<string | undefined>()
        t.completed()
        t.textContains("ok")
        t.calledTool("lookup")
        t.doesNotCallTool("refund")
        t.hasCapabilityExtension("observability")
        t.expect(scorer)
        t.expect(capabilityScorer)
      },
    })

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
      driver: { model: ({ runtimeConfig }: AgentRuntimeContext<TestRuntimeConfig> & { runtimeConfig: TestRuntimeConfig }) => {
          runtimeConfig.service.token.toUpperCase()
          return {} as never
        } },
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
        driver: { model: {} as never },
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

  it("exposes output helpers from the output entry", () => {
    expectTypeOf(toAgentRunResult("ok").text).toEqualTypeOf<string | undefined>()
    expectTypeOf(streamAgentOutputToEvents("ok")).toEqualTypeOf<AsyncIterable<StreamEvent>>()
  })
})
