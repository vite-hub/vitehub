import { describe, expectTypeOf, it } from "vitest"

import { defineAgent, defineAgentInvoker, defineCapability, defineFinishEffect, runAgent, runAgentInline, startAgentInvocation, type AgentActor, type AgentCapabilitiesResolverContext, type AgentCapabilityCliCommand, type AgentCapabilityCliResolver, type AgentCapabilityDefinition, type AgentChannelDeliveryEffectContext, type AgentChannelDeliveryEffectIntent, type AgentChannelDeliveryEffectKind, type AgentChannelDeliveryFinishEffect, type AgentChannelDeliveryFinishEffectContext, type AgentChannelDefinition, type AgentChannelDeliveryReplyPayload, type AgentChannelDeliveryReplyStream, type AgentChannelFactory, type AgentChannelInput, type AgentChannelInputs, type AgentDeliveryArtifact, type AgentDriver, type AgentDriverCapacityOptions, type AgentDriverCapacityQueueOptions, type AgentErrorHookEvent, type AgentFinishEvent, type AgentFinishHookEvent, type AgentHarnessDriver, type AgentHookObserverEvent, type AgentInvoker, type AgentMessageChannelSettings, type AgentMessageDeliveryKind, type AgentModuleOptions, type AgentRunInput, type AgentRunInputContextValues, type AgentRunResult, type AgentRuntimeConfig, type AgentRuntimeContext, type AgentUIMessageStreamProjection, type AgentUsageRecord, type ImagePart, type PublishedAgentDeliveryArtifact } from "../src/index.ts"
import { access, blob, browser, chat, title, db, email, fetch, getTranscriptionResults, git, inputCommands, kv, mcp, openapi, papercuts, repositoryHost, repositoryHostContext, sandbox, schedule, skills, streamTranscription, subagents, transcribe, usageCost, vercelAiGatewayPricing, webSearch, workspaceShell, type AgentUsagePricing, type EmailCapabilityOptions, type EmailCapabilityToolPolicy, type PapercutReportContext, type PapercutReportEvent, type SubagentToolInput, type UsageCostOptions, type VercelAiGatewayPricingOptions } from "../src/capabilities.ts"
import { defineChannel, github, http, pullRequest, teams, telegram, webChat, type GitHubPullRequestCommand, type GitHubPullRequestRunContext } from "../src/channels.ts"
import { defineEval, hasCapabilityExtension, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import { streamAgentOutputToEvents, toAgentRunResult } from "../src/output.ts"
import { defineAgentRunEvents, type AgentRunEventPublisher } from "../src/server.ts"
import type { AgentChatFinishExtension, AgentInvocationContextStore, AgentInvokerProfile, AgentOutputExtensionProvider, AgentToolDefinition, AgentToolSchema, StreamEvent } from "../src/index.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { file, github as githubSource, type ReadonlyWorkspaceFacade } from "@vite-hub/workspace"
import type { AccessInvocationContextValue, AccessWorkspaceOptionsFor, AgentChatRunContext, FetchCapabilityToolOptions, RepositoryHostClient, RepositoryHostContextValue, TranscriptionResult } from "../src/capabilities.ts"

declare global {
  interface ViteHubAgentInvocationContextValues {
    "chat.secret": string
  }
  interface ViteHubAgentChannelMeta {
    customer?: string
  }
  interface ViteHubAgentChannelUser {
    email?: string
  }
}

describe("agent public types", () => {
  it("types bounded driver capacity", () => {
    const queue = { maxPending: 20, timeout: 300_000 } satisfies AgentDriverCapacityQueueOptions
    const capacity = { concurrency: 2, queue } satisfies AgentDriverCapacityOptions

    defineAgent({
      driver: {
        capacity,
        run: () => "ok",
      },
    })
  })

  it("types usage cost pricing and finish extensions", () => {
    const pricing = ((context) => {
      expectTypeOf(context.usage).toMatchTypeOf<NonNullable<AgentUsageRecord["usage"]>>()
      return {
        amount: "0.01",
        currency: "USD",
        estimated: true,
        source: "custom",
      }
    }) satisfies AgentUsagePricing
    const options = { pricing } satisfies UsageCostOptions
    const gatewayPricingOptions = { timeout: 5_000 } satisfies VercelAiGatewayPricingOptions

    expectTypeOf(usageCost(options)).toMatchTypeOf<AgentCapabilityDefinition>()
    expectTypeOf(vercelAiGatewayPricing(gatewayPricingOptions)).toMatchTypeOf<AgentUsagePricing>()
    defineAgent({
      capabilities: [usageCost(options)],
      driver: { run: () => "ok" },
      hooks: {
        "agent:error"(event) {
          expectTypeOf(event).toMatchTypeOf<AgentErrorHookEvent>()
          expectTypeOf<AgentErrorHookEvent>().toMatchTypeOf<{ error: unknown }>()
          expectTypeOf(event.error).toEqualTypeOf<unknown>()
          expectTypeOf(event.errorMessage).toEqualTypeOf<string>()
          // @ts-expect-error Agent Error Hooks do not receive successful results.
          void event.result
          // @ts-expect-error Agent Error Hooks do not receive successful text.
          void event.text
        },
        "agent:finish"(event) {
          expectTypeOf(event).toMatchTypeOf<AgentFinishHookEvent>()
          // @ts-expect-error Agent Finish Hooks do not receive failed outcomes.
          void event.error
          // @ts-expect-error Agent Finish Hooks do not receive normalized error messages.
          void event.errorMessage
          expectTypeOf(event.extensions.get("usage-cost")).toEqualTypeOf<AgentUsageRecord | undefined>()
        },
      },
    })
  })

  it("types static and per-invocation UI message stream projection", () => {
    const projection = {
      reasoning: "visible",
      tools: "full",
    } satisfies AgentUIMessageStreamProjection

    defineAgent({
      driver: { run: () => "ok" },
      uiMessageStream: projection,
    })
    defineAgent({
      driver: { run: () => "ok" },
      uiMessageStream(context) {
        expectTypeOf(context.input).toEqualTypeOf<AgentRunInput>()
        expectTypeOf(context.context.get("chat.secret")).toEqualTypeOf<string | undefined>()
        return context.input.prompt === "private"
          ? { reasoning: "hidden", tools: "hidden" }
          : projection
      },
    })
    defineAgent({
      driver: { run: () => "ok" },
      // @ts-expect-error Reasoning projection has no full mode.
      uiMessageStream: { reasoning: "full" },
    })
  })

  it("types the Email capability as one explicit send grant", () => {
    const policy: EmailCapabilityToolPolicy = "require-approval"
    const options = { from: "agent@example.com", policy, recipients: ["owner@example.com"] as const } satisfies EmailCapabilityOptions

    expectTypeOf(email(options)).toMatchTypeOf<AgentCapabilityDefinition>()
    // @ts-expect-error Email requires an application-owned sender.
    email({})
    // @ts-expect-error Email has no read mode.
    email({ from: "agent@example.com", mode: "read" })
    // @ts-expect-error Email recipients must be an array.
    email({ from: "agent@example.com", recipients: "owner@example.com" })
    // @ts-expect-error Email recipient entries must be strings.
    email({ from: "agent@example.com", recipients: [123] })
  })

  it("exposes a run-scoped event publisher across Agent phases", () => {
    const runEvents = defineAgentRunEvents({
      store: {
        append: (_runId, event) => ({ ...event, cursor: "1", runId: "run-1", timestamp: new Date(0).toISOString() }),
        read: () => [],
        subscribe: () => (async function* () {})(),
      },
    })

    defineAgent({
      capabilities: [defineCapability({
        id: "progress",
        input(context) {
          expectTypeOf(context.runEvents).toEqualTypeOf<AgentRunEventPublisher | undefined>()
        },
      })],
      driver: {
        run(context) {
          expectTypeOf(context.runEvents).toEqualTypeOf<AgentRunEventPublisher | undefined>()
        },
      },
      hooks: {
        "agent:finish"(event) {
          expectTypeOf(event.runtime.runEvents).toEqualTypeOf<AgentRunEventPublisher | undefined>()
        },
      },
      runEvents,
    })

    const handWritten = {
      publish: runEvents.publish,
      read: runEvents.read,
      subscribe: runEvents.subscribe,
    }
    defineAgent({
      driver: { run: () => "ok" },
      // @ts-expect-error Agent Run Events must be created by defineAgentRunEvents().
      runEvents: handWritten,
    })
  })

  it("infers structured Agent output from its Standard Schema", () => {
    const schema = {
      "~standard": {
        validate: (input: unknown) => ({ value: input as { summary: string, title: string } }),
        vendor: "test",
        version: 1 as const,
      },
    } satisfies StandardSchemaV1<unknown, { summary: string, title: string }>
    const agent = defineAgent({
      driver: { output: { schema }, run: () => "{}" },
      runtime: false,
    })
    const result = runAgentInline(agent, {} as AgentRuntimeContext, {})
    const rawResult = runAgentInline(agent, {} as AgentRuntimeContext, {}, { output: "raw" })
    const workflowResult = runAgent(agent, {} as AgentRuntimeContext, {})
    const controlled = startAgentInvocation(agent, {} as AgentRuntimeContext, {})

    expectTypeOf(result).toEqualTypeOf<Promise<Response | { summary: string, title: string }>>()
    expectTypeOf(rawResult).toEqualTypeOf<Promise<unknown>>()
    expectTypeOf<Extract<Awaited<typeof workflowResult>, { id: string }>["result"]>().toEqualTypeOf<{ summary: string, title: string } | undefined>()
    expectTypeOf<Awaited<typeof controlled>["support"]>().toEqualTypeOf<{ followUp: boolean, steer: boolean }>()
    expectTypeOf<Extract<Awaited<ReturnType<Awaited<typeof controlled>["inspect"]>>, { outcome: "available" }>["invocation"]["output"]>().toEqualTypeOf<Response | { summary: string, title: string } | undefined>()
  })

  it("accepts literal false as the inline runtime opt-out", () => {
    const agent = defineAgent({
      driver: { run: () => "ok" },
      runtime: false,
    })

    expectTypeOf(agent.runtime).toEqualTypeOf<false | import("../src/index.ts").AgentWorkflowRuntimeBinding | undefined>()
    defineAgent({
      driver: { run: () => "ok" },
      // @ts-expect-error true is not an Agent runtime binding.
      runtime: true,
    })
  })

  it("accepts chat dispatcher routes and keeps Channel webhook routes out of hubAgent options", () => {
    const standardChatRoute: AgentModuleOptions = { routes: { chat: true } }
    const customChatRoute: AgentModuleOptions = { routes: { chat: "/chat/[agent]" } }
    const disabledChatRoute: AgentModuleOptions = { routes: { chat: false } }
    const webhookRoute: AgentModuleOptions = {
      routes: {
        // @ts-expect-error Webhook route ownership belongs to Channels.
        webhooks: true,
      },
    }
    void standardChatRoute
    void customChatRoute
    void disabledChatRoute
    void webhookRoute
  })

  it("keeps Agent Eval configuration as runner options rather than an activation toggle", () => {
    const evalOptions: AgentModuleOptions = {
      eval: {
        maxConcurrency: 2,
        testTimeout: 60_000,
      },
    }
    const disabledEval: AgentModuleOptions = {
      // @ts-expect-error Executable Eval files control activation.
      eval: false,
    }
    void evalOptions
    void disabledEval
  })

  it("accepts zero-argument Channel factories and keeps configured Channels explicit", () => {
    interface RuntimeConfig extends AgentRuntimeConfig {
      token: string
    }
    const factory: AgentChannelFactory = webChat
    const runtimeFactory: AgentChannelFactory<RuntimeConfig> = webChat
    const input: AgentChannelInput = factory
    const inputs: AgentChannelInputs = { portal: input }

    defineAgent({ channels: inputs, driver: { run: () => "ok" } })
    const runtimeAgent = defineAgent<RuntimeConfig>({ channels: { web: runtimeFactory }, driver: { run: () => "ok" } })
    expectTypeOf(runtimeAgent.channels?.web).toEqualTypeOf<AgentChannelDefinition<RuntimeConfig> | undefined>()
    defineAgent({ channels: { portal: webChat }, driver: { run: () => "ok" } })
    defineAgent({ channels: { portal: webChat() }, driver: { run: () => "ok" } })
    defineAgent({ channels: { portal: webChat({ messages: { sessions: false } }) }, driver: { run: () => "ok" } })
    defineAgent({
      channels: {
        portal: webChat(),
        telegram: {
          allowedUserIds: context => [context.runtime === "vite" ? 1 : 2],
          messages: { delivery: "manual", triggerHistory: "none" },
        },
      },
      driver: { maxRetries: 0, model: () => ({}) as never },
    })

    const requiresOptions = (_options: { route: boolean }) => webChat()
    defineAgent({
      channels: {
        // @ts-expect-error Channel factories cannot require arguments.
        portal: requiresOptions,
      },
      driver: { run: () => "ok" },
    })

    defineAgent({
      channels: {
        // @ts-expect-error Channel factories must return Channel definitions.
        portal: () => ({ route: true }),
      },
      driver: { run: () => "ok" },
    })

    defineAgent({
      channels: {
        // @ts-expect-error Channel factories must resolve synchronously.
        portal: async () => webChat(),
      },
      driver: { run: () => "ok" },
    })
  })

  it("accepts portable and raw JSON tool schemas", () => {
    const portableSchema = {
      "~standard": {
        jsonSchema: {
          input: () => ({ properties: { message: { type: "string" } }, type: "object" }),
          output: () => ({ properties: { message: { type: "string" } }, type: "object" }),
        },
        validate: (input: unknown) => ({ value: input as { message: string } }),
        vendor: "test",
        version: 1 as const,
      },
    } satisfies AgentToolSchema<{ message: string }>

    const portableTool = {
      execute(input) {
        expectTypeOf(input.message).toEqualTypeOf<string>()
        return { saved: true }
      },
      inputSchema: portableSchema,
      name: "report",
    } satisfies AgentToolDefinition<{ message: string }, { saved: boolean }>

    const jsonSchemaTool = {
      inputSchema: {
        additionalProperties: false,
        properties: { message: { type: "string" } },
        required: ["message"],
        type: "object",
      },
      name: "report",
    } satisfies AgentToolDefinition<{ message: string }>

    const validationOnlySchema = {
      "~standard": {
        validate: (input: unknown) => ({ value: input as { message: string } }),
        vendor: "test",
        version: 1 as const,
      },
      type: "object" as const,
    } satisfies StandardSchemaV1<unknown, { message: string }> & { type: "object" }

    const validationOnlyTool: AgentToolDefinition<{ message: string }> = {
      // @ts-expect-error Tool schemas must also describe their JSON shape to the model.
      inputSchema: validationOnlySchema,
      name: "report",
    }

    expectTypeOf(portableTool.inputSchema).toEqualTypeOf<typeof portableSchema>()
    expectTypeOf(jsonSchemaTool).toMatchTypeOf<AgentToolDefinition<{ message: string }>>()
    expectTypeOf(validationOnlyTool).toEqualTypeOf<AgentToolDefinition<{ message: string }>>()
  })

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
        blob({ mode: "write", policy: () => "require-approval", store: "assets" }),
        db({ database: "analytics", mode: "write", schemaMode: "write" }),
        fetch({
          tools: {
            status: {
              inputSchema: {
                "~standard": {
                  jsonSchema: {
                    input: () => ({ properties: { region: { type: "string" } }, type: "object" }),
                    output: () => ({ properties: { region: { type: "string" } }, type: "object" }),
                  },
                  validate: (input: unknown) => ({ value: input as { region: string } }),
                  vendor: "test",
                  version: 1,
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
                  vendor: "test",
                  version: 1,
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
        openapi({
          cli: context => context.run?.channelId === "portal"
            ? {
                description: "Inspect live Portal data.",
                name: "portal-api",
              }
            : undefined,
          operations: ["listCustomers"],
          spec: openAPISpec,
        }),
        git(),
        git({ mode: "read" }),
        git({ mode: "write", policy: "require-approval" }),
        browser(),
        browser({ command: "agent-browser", skillContent: "# Browser\n", skillPath: "skills/browser/SKILL.md", sourceKey: "skill.browser" }),
        workspaceShell({ commands: ["agent-browser", "/Users/maxi/quiver/agents/node_modules/.bin/agent-browser"] }),
        workspaceShell({ commands: "all", mode: "write" }),
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
          integrity: {
            direct: { search: "reviewed-fingerprint" },
          },
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
        repositoryHostContext({
          context: {
            pullRequest: {
              number: 12,
              repository: "acme/app",
            },
          } satisfies RepositoryHostContextValue,
          materialize: "./PULL_REQUEST.template.md",
        }),
        skills(),
        skills({ path: "skills/agent-browser", source: githubSource({ repo: "vercel/vercel-plugin", root: "skills/agent-browser" }) }),
        skills({ path: "skills/agent-browser", scope: "global", source: githubSource({ repo: "vercel/vercel-plugin", root: "skills/agent-browser" }) }),
        skills({ path: "skills/agent-browser", shellExecution: "write", source: githubSource({ repo: "vercel/vercel-plugin", root: "skills/agent-browser" }) }),
        skills({ shellExecution: "read" }),
        skills({ shellExecution: "write" }),
        sandbox({ commands: ["node"] }),
        schedule({ mode: "read", targets: ["daily-reports"] as const }),
        schedule({ allowSelfTarget: true, delivery: "origin", mode: "write", policy: "require-approval", targets: ["daily-reports"] as const, timeZone: "Asia/Bangkok" }),
        transcribe({
          execute({ audio }) {
            expectTypeOf(audio.mediaType).toEqualTypeOf<string>()
            return "transcript"
          },
        }),
        title({
          channelDelivery: "once-per-thread",
          model: () => ({}),
          template({ fallback, maxLength, source, text, trigger }) {
            expectTypeOf(fallback).toEqualTypeOf<string>()
            expectTypeOf(maxLength).toEqualTypeOf<number>()
            expectTypeOf(source).toEqualTypeOf<"input" | "response">()
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
        sandbox: ({ input }) => {
          expectTypeOf(input.prompt).toEqualTypeOf<AgentRunInput["prompt"]>()
          return { providerId: "local-test" }
        },
      },
    })

    type GeneratedScheduleTargetName = "daily-reports" | "weekly-cleanup"
    schedule<GeneratedScheduleTargetName>({ mode: "write", targets: ["daily-reports"] })
    // @ts-expect-error target allowlists are typed by generated Schedule Target Names where supplied
    schedule<GeneratedScheduleTargetName>({ mode: "write", targets: ["missing"] })
    // @ts-expect-error self targets are inferred from the discovered Agent name
    schedule({ mode: "write", selfTarget: "agent/digest" })
    // @ts-expect-error origin is the only durable delivery mode
    schedule({ allowSelfTarget: true, delivery: "discord", mode: "write" })

    // @ts-expect-error web search mode is required
    webSearch({})

    // @ts-expect-error tool mode requires one explicit provider
    webSearch({ mode: "tool" })

    // @ts-expect-error skills shell execution mode must be read or write
    skills({ shellExecution: "allow" })

    // @ts-expect-error skills scope must be global or workspace
    skills({ scope: "profile" })

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
        directory: "inbox",
        transcript: { format: "markdown" },
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
          expectTypeOf(event.extensions.get("missing")).toEqualTypeOf<unknown>()
          expectTypeOf(event.invocation.usage).toEqualTypeOf<AgentUsageRecord | undefined>()
          // @ts-expect-error Agent Finish Hooks exclude normalized error messages.
          void event.errorMessage
          return event.reply((async function* () {
            yield "streamed reply"
          })())
        },
      },
    })

    const streamingTranscription = streamTranscription({
      audio: new ReadableStream<Uint8Array>(),
      inputAudioFormat: { rate: 24_000, type: "audio/pcm" },
      model: "openai/gpt-realtime-whisper",
    })
    expectTypeOf(streamingTranscription).toMatchTypeOf<Promise<{
      text: PromiseLike<string>
      textStream: AsyncIterable<string>
    }>>()

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

    defineAgent({
      driver: { model: {} as never },
      workspace: { commit: "chore: update workspace", mode: "write" },
    })

    defineAgent({
      driver: { model: {} as never },
      // @ts-expect-error workspace reference mode must be read or write
      workspace: { name: "review", mode: "mutable" },
    })

    defineAgent({
      driver: { model: {} as never },
      // @ts-expect-error named workspace references cannot include colocated Workspace Definition options
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

    const _invocationHarnessDriver: AgentHarnessDriver<AgentRuntimeConfig, { pullRequest: number }> = {
      harness: { provider: "codex" },
      instructions({ input }) {
        expectTypeOf(input.options).toEqualTypeOf<{ pullRequest: number } | undefined>()
        return `Repair pull request ${input.options?.pullRequest}.`
      },
      workDir({ input }) {
        expectTypeOf(input.options).toEqualTypeOf<{ pullRequest: number } | undefined>()
        return `pull-requests/${input.options?.pullRequest}`
      },
    }

    // @ts-expect-error Agent Driver variants are mutually exclusive
    const _mixedDriver: AgentDriver = { model: "model", run: () => "ok" }

    // @ts-expect-error raw harness permissions are intentionally not public in V1
    const _permissionDriver: AgentDriver = { harness: { provider: "codex" }, permissions: "bypass" }

    // @ts-expect-error harness permission mode is runtime policy, not a public Agent Driver option
    const _permissionModeDriver: AgentDriver = { harness: { provider: "codex" }, permissionMode: "allow-edits" }

    const _sandboxDriver: AgentDriver = { harness: { provider: "codex" }, sandbox: { provider: "sandbox" } }
    const _codexDriver: AgentDriver = "codex"
    const _configuredCodexDriver: AgentDriver = { kind: "codex", model: "gpt-5.6-codex", reasoningEffort: "high" }
    const _claudeCodeDriver: AgentDriver = "claude-code"
    const _configuredClaudeCodeDriver: AgentDriver = { kind: "claude-code", maxTurns: 12, model: "claude-opus-4-6" }
    void _codexDriver
    void _configuredCodexDriver
    void _claudeCodeDriver
    void _configuredClaudeCodeDriver

    // @ts-expect-error Unknown built-in Agent Driver names are rejected.
    const _unknownBuiltInDriver: AgentDriver = "custom"
    // @ts-expect-error Tagged built-ins cannot use an unknown kind.
    const _unknownTaggedDriver: AgentDriver = { kind: "custom" }
    // @ts-expect-error Built-in names are reserved and cannot be custom run drivers.
    const _reservedCustomDriver: AgentDriver = { kind: "codex", run: () => "ok" }
    void _unknownBuiltInDriver
    void _unknownTaggedDriver
    void _reservedCustomDriver

    defineAgent({
      cli: { capabilities: false },
      driver: { harness: { provider: "codex" } },
    })

    defineAgent({
      driver: { harness: { provider: "codex" } },
      // @ts-expect-error harness sandbox providers belong under driver.sandbox
      harnessSandbox: { provider: "sandbox" },
    })

    // @ts-expect-error raw harness credential material is not accepted by the generic driver boundary
    const _rawCredentialDriver: AgentDriver = { credentials: { value: "secret" }, harness: { provider: "codex" } }

    // @ts-expect-error Agent Driver is not parameterized by Workspace Name
    type _agentDriverNoWorkspaceNameGeneric = AgentDriver<AgentRuntimeConfig, unknown, "docs">

    inputCommands({
      commands: {
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
    // @ts-expect-error pull request context belongs to the GitHub Channel
    type _PublicPullRequestContext = CapabilityExports["pullRequestContext"]
    // @ts-expect-error app-owned ingress belongs to Channels, not entry()
    type _PublicEntry = CapabilityExports["entry"]
    // @ts-expect-error Access Capability Type Contract is internal to access() inference
    type _PublicAccessCapabilityTypeContract = CapabilityExports["AccessCapabilityTypeContract"]
    // @ts-expect-error transcription extension inference is internal, not public capabilities API
    type _PublicAudioExtensionFor = CapabilityExports["audioExtensionFor"]
    // @ts-expect-error transcription context storage key is internal, not public capabilities API
    type _PublicTranscriptionContextKey = CapabilityExports["TRANSCRIPTION_RESULTS_CONTEXT_KEY"]
  })

  it("accepts invocation-resolved Agent Capabilities", () => {
    const conditional = defineCapability({
      id: "conditional",
      tools: {},
    })

    defineAgent({
      capabilities: async (context) => {
        expectTypeOf(context).toEqualTypeOf<AgentCapabilitiesResolverContext>()
        expectTypeOf(context.actor.id).toEqualTypeOf<string>()
        expectTypeOf(context.channel?.meta?.customer).toEqualTypeOf<string | undefined>()
        expectTypeOf(context.context.get<boolean>("enabled")).toEqualTypeOf<boolean | undefined>()
        expectTypeOf(context.driver.kind).toEqualTypeOf<"harness" | "model" | "run">()
        expectTypeOf(context.input.prompt).toEqualTypeOf<AgentRunInput["prompt"]>()
        expectTypeOf(context.run?.channelId).toEqualTypeOf<string | undefined>()
        return context.context.get<boolean>("enabled") ? [conditional] : []
      },
      driver: { run: () => "ok" },
    })
  })

  it("types Papercut report events from the capabilities entry", () => {
    const capability = papercuts({
      async report(event) {
        expectTypeOf(event).toEqualTypeOf<PapercutReportEvent>()
        expectTypeOf(event.context.actor.id).toEqualTypeOf<string>()
        expectTypeOf(event.papercut.createdAt).toEqualTypeOf<string>()
        expectTypeOf(event.papercut.message).toEqualTypeOf<string>()
        expectTypeOf(event.papercut.source).toEqualTypeOf<"cli" | "tool">()
        expectTypeOf(event.context).toEqualTypeOf<PapercutReportContext>()
        expectTypeOf(event.context.workspace).toEqualTypeOf<ReadonlyWorkspaceFacade | undefined>()
        expectTypeOf(event.context.fs).toEqualTypeOf<ReadonlyWorkspaceFacade["fs"] | undefined>()
      },
    })

    expectTypeOf(capability.id).toEqualTypeOf<string>()
    type RootAgentExports = typeof import("../src/index.ts")
    // @ts-expect-error official Capability factories are exported from the capabilities entry.
    type _RootPapercuts = RootAgentExports["papercuts"]
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

    expectTypeOf(inventoryRuntime.cli).toMatchTypeOf<AgentCapabilityCliResolver | undefined>()
    const image: ImagePart = {
      fetchData: () => new Uint8Array([1]),
      fetchMetadata: { fileId: "provider-file" },
      mediaType: "image/png",
      name: "photo.png",
      size: 1,
      type: "image",
      url: "https://example.com/photo.png",
    }
    expectTypeOf(image.fetchData).toMatchTypeOf<(() => ArrayBuffer | Blob | string | Uint8Array | Promise<ArrayBuffer | Blob | string | Uint8Array>) | undefined>()

    defineCapability({
      // @ts-expect-error Attachments are normalized by default rather than enabled by a Capability.
      chatAttachments: { audio: true },
      id: "legacy-audio-runtime",
    })

    defineCapability({
      id: "legacy-instructions",
      // @ts-expect-error Capability instructions were removed from Capability definitions.
      instructions: "Use inventory only for runtime data.",
    })
    const dynamicInventoryRuntime = defineCapability({
      id: "dynamic-inventory-runtime",
      cli: context => context.run?.channelId === "portal"
        ? {
            commands: {
              list: {
                run: () => ({ items: [] }),
              },
            },
            name: "inventory",
          }
        : undefined,
    })
    expectTypeOf(dynamicInventoryRuntime.cli).toMatchTypeOf<AgentCapabilityCliResolver | undefined>()
    type RootAgentExports = typeof import("../src/index.ts")
    // @ts-expect-error Capability CLI builders are not root Agent Package exports
    type _RootCliBuilder = RootAgentExports["cli"]
    // @ts-expect-error Capability CLI command builders are not root Agent Package exports
    type _RootCommandBuilder = RootAgentExports["command"]
  })

  it("accepts message settings and channels from the Agent Definition", () => {
    const messages: AgentMessageChannelSettings = {
      commentary: "hidden",
      concurrency: "queue",
      sessions: true,
      triggerHistory: { maxMessages: 20, source: "thread" },
    }
    const channel: AgentChannelDefinition = teams()
    expectTypeOf(channel.kind).toEqualTypeOf<string>()
    const reviewFinishEffect: AgentChannelDeliveryFinishEffect = context => ({
      kind: "reply",
      payload: context.output,
    })
    const renderBody = async (text: string, workspace?: ReadonlyWorkspaceFacade) => `${text}:${Boolean(workspace)}`
    const typedFinishEffect = defineFinishEffect(async (context, event) => {
      expectTypeOf(event).toEqualTypeOf<AgentFinishEvent | undefined>()
      expectTypeOf(context.event).toEqualTypeOf<AgentFinishEvent>()
      expectTypeOf(context.output).toEqualTypeOf<unknown>()
      expectTypeOf(context.result).toEqualTypeOf<AgentRunResult | undefined>()
      expectTypeOf(context.text).toEqualTypeOf<string | undefined>()
      expectTypeOf(context.invocation.usage).toEqualTypeOf<AgentUsageRecord | undefined>()
      expectTypeOf(context.context).toEqualTypeOf<AgentChannelDeliveryFinishEffectContext["context"]>()
      expectTypeOf(context.context.get<{ repository: string }>("review.context")).toEqualTypeOf<{ repository: string } | undefined>()
      expectTypeOf(context.request).toEqualTypeOf<Request | undefined>()
      expectTypeOf(context.workspace).toEqualTypeOf<ReadonlyWorkspaceFacade | undefined>()
      if (context.error) return context.reply(`failed: ${context.errorMessage}`)
      const text = context.result?.text
      if (!text) return
      return context.reply(await renderBody(text, context.workspace))
    })
    expectTypeOf(typedFinishEffect).toMatchTypeOf<AgentChannelDeliveryFinishEffect>()
    defineFinishEffect((context) => {
      expectTypeOf(context.reply("done")).toEqualTypeOf<AgentChannelDeliveryEffectIntent<"reply">>()
      expectTypeOf(context.reaction("eyes")).toEqualTypeOf<AgentChannelDeliveryEffectIntent<"reaction">>()
      expectTypeOf(context.status("pending")).toEqualTypeOf<AgentChannelDeliveryEffectIntent<"status">>()
      expectTypeOf(context.reply({ markdown: "done" }).payload).toEqualTypeOf<AgentChannelDeliveryReplyPayload | AgentChannelDeliveryReplyStream | string | undefined>()
    })
    // @ts-expect-error Development samples belong in CLI payload files, not Channel options.
    teams({ dev: { samples: {} } })
    // @ts-expect-error Development samples belong in CLI payload files, not Channel Definitions.
    defineChannel("portal", { dev: { samples: {} } })
    const custom = defineChannel("portal", {
      capabilities: [defineCapability({ id: "portal-api" })],
      effects: {
        reaction(context) {
          expectTypeOf(context.effect.kind).toEqualTypeOf<AgentChannelDeliveryEffectKind>()
          expectTypeOf(context.effect).toEqualTypeOf<AgentChannelDeliveryEffectIntent>()
          expectTypeOf(context.effect.artifacts?.[0]).toEqualTypeOf<PublishedAgentDeliveryArtifact | undefined>()
          expectTypeOf(context.context).toEqualTypeOf<AgentChannelDeliveryEffectContext["context"]>()
          expectTypeOf(context.request).toEqualTypeOf<Request | undefined>()
          expectTypeOf(context.workspace).toEqualTypeOf<AgentChannelDeliveryEffectContext["workspace"]>()
        },
      },
      messages: false,
      triggers: {
        event: {
          invoke(context, input: { text: string }) {
            expectTypeOf(context.agentCapabilities).toEqualTypeOf<readonly AgentCapabilityDefinition[]>()
            expectTypeOf(context.channel.kind).toEqualTypeOf<string>()
            expectTypeOf(context.trigger.channelId).toEqualTypeOf<string>()
            expectTypeOf(input.text).toEqualTypeOf<string>()
            return {
              delivery: {
                finishEffects: (context, event) => {
                  expectTypeOf(event).toEqualTypeOf<AgentFinishEvent | undefined>()
                  expectTypeOf(context.context).toEqualTypeOf<AgentChannelDeliveryFinishEffectContext["context"]>()
                  expectTypeOf(context.request).toEqualTypeOf<Request | undefined>()
                  expectTypeOf(context.invocation.usage).toEqualTypeOf<AgentUsageRecord | undefined>()
                  expectTypeOf(context.workspace).toEqualTypeOf<AgentChannelDeliveryFinishEffectContext["workspace"]>()
                  return context.reply(String(context.output), {
                    artifacts: [{ path: "screenshots/result.png", url: "https://assets.example/result.png" }],
                  })
                },
              },
              input: { prompt: input.text },
            }
          },
        },
      },
    })
    expectTypeOf(custom.capabilities?.[0]).toEqualTypeOf<AgentCapabilityDefinition | undefined>()
    expectTypeOf(custom.kind).toEqualTypeOf<string>()
    expectTypeOf<AgentDeliveryArtifact>().toMatchTypeOf<{ path: string }>()

    defineAgent({
      capabilities: [{
        id: "feedback",
        prepare(context) {
          context.delivery.effect({ intent: "started", kind: "reaction" })
          context.delivery.finishEffect(context => context.reply(String(context.output)))
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
              expectTypeOf(pullRequest?.pullRequest.metadata?.unavailable).toEqualTypeOf<string | undefined>()
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
          pullRequest: {
            maxBodyLength: 12_000,
            maxCommentBodyLength: 2_000,
            maxComments: 30,
            maxFiles: 200,
            origin: "github-review",
            reply: reviewFinishEffect,
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
          allowedUserIds: ["123"],
          botToken: () => "telegram-token",
          mode: "webhook",
          webhookSecret: () => "webhook-secret",
        }),
        portalWeb: webChat({
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
              trust: ["meta", "user", "session", "timeout"],
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
    // @ts-expect-error streaming is delivery behavior, not a public Channel Kind.
    type _PublicStream = ChannelExports["stream"]
    type _PublicTelegram = ChannelExports["telegram"]
    type _PublicTeams = ChannelExports["teams"]

    type ServerExports = typeof import("../src/server.ts")
    type _PublicDiscordGatewayRouteHandler = ServerExports["createDiscordGatewayRouteHandler"]
    // @ts-expect-error generated route handler factories are internal Provider Output plumbing.
    type _PublicChannelChatRouteHandler = ServerExports["createChannelChatRouteHandler"]
    // @ts-expect-error generated route handler factories are internal Provider Output plumbing.
    type _PublicChannelWebhookRouteHandler = ServerExports["createChannelWebhookRouteHandler"]
    type InternalServerExports = typeof import("../src/server/internal.ts")
    type _InternalChannelChatRouteHandler = InternalServerExports["createChannelChatRouteHandler"]
  })

  it("types access workspace source grants and chat run context", () => {
    const workspace = {
      sources: {
        docs: file("AGENTS.md"),
        forecastingEngine: githubSource({ repo: "acme/forecasting-engine" }),
        pullRequest: githubSource(({ invocation }) => {
          const source = pullRequest.read(invocation).source
          if (!source?.repo || !source.ref) return false
          expectTypeOf(source.repo).toEqualTypeOf<string>()
          expectTypeOf(source.ref).toEqualTypeOf<string>()
          return {
            repo: source.repo,
            ref: source.ref,
            root: "portal",
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
    const teamsAdapter = () => ({}) as never
    const supportChat = chat({
      identity: ({ adapter, author }) => `${adapter}:${author.userId}`,
      transcripts: {
        maxPerUser: 50,
        retention: "30d",
      },
    })
    chat({
      // @ts-expect-error platform adapters live on defineAgent({ channels })
      platforms: () => ({ teams: teamsAdapter }),
    })
    chat({
      // @ts-expect-error webhook routes live on adapter-backed defineAgent({ channels })
      webhooks: { teams: { path: "/api/teams/webhook" } },
    })
    chat({
      // @ts-expect-error adapters was removed; use defineAgent({ channels })
      adapters: () => ({ teams: teamsAdapter }),
    })
    defineAgent({
      channels: {
        teams: teams({ adapter: teamsAdapter }),
      },
      messages: {
        filter: ({ deliveryKind }) => {
          expectTypeOf(deliveryKind).toEqualTypeOf<AgentMessageDeliveryKind>()
          return deliveryKind === "direct" || deliveryKind === "mention"
        },
        identity: ({ adapter, author }) => `${adapter}:${author.userId}`,
        transcripts: {
          maxPerUser: 50,
          retention: "30d",
        },
      },
      driver: {
        run: () => "ok",
      },
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
    }
    // @ts-expect-error Child invocation identity is assigned below the model tool input.
    const legacyBrowserToolInput: SubagentToolInput = { message: "Check the product card.", runId: "review-run:browser" }
    expectTypeOf(legacyBrowserToolInput).toMatchTypeOf<SubagentToolInput>()
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
        expectTypeOf(actor.email?.address).toEqualTypeOf<string | undefined>()
        expectTypeOf(actor.email?.domain).toEqualTypeOf<string | undefined>()
        expectTypeOf(actor.id).toEqualTypeOf<string>()
        expectTypeOf(invoker.email?.address).toEqualTypeOf<string | undefined>()
        expectTypeOf(invoker.email?.domain).toEqualTypeOf<string | undefined>()
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
      // @ts-expect-error access source grants are checked against defineAgent({ workspace.sources })
      workspace: {
        sources: {
          docs: file("AGENTS.md"),
        },
      },
    })

    defineAgent({
      capabilities: () => [
        access({
          workspace: {
            scopes: {
              customer: { source: "missing" },
            },
          },
        }),
      ] as const,
      driver: { model: {} as never },
      // @ts-expect-error callback access source grants are checked against defineAgent({ workspace.sources })
      workspace: {
        sources: {
          docs: file("AGENTS.md"),
        },
      },
    })

    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs" }),
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
          docs: file("README.md"),
          ingestion: githubSource({ repo: "acme/ingestion" }),
        },
      },
      capabilities: [
        access({
          workspace: {
            resolve() {
              return "technical" as const
            },
            scopes: {
              technical: { source: "ingestion" },
            },
          },
        }),
      ],
      driver: { model: {} as never },
    })

    const reviewWorkspace = defineCapability({
      id: "review-workspace",
      workspaceSources: {
        pullRequest: file("pull-request/summary.md"),
      },
    })
    const reviewWorkspaceBundle = defineCapability({
      capabilities: [reviewWorkspace],
      id: "review-workspace-bundle",
    })
    defineAgent({
      workspace: { sources: {} },
      capabilities: [
        access({
          workspace: {
            defaultScope: "review",
            scopes: {
              review: { source: "pullRequest" },
            },
          },
        }),
        reviewWorkspaceBundle,
      ],
      driver: { model: {} as never },
    })

    defineAgent({
      // @ts-expect-error Workspace Sources do not own access scopes.
      workspace: {
        sources: {
          raw: {
            scopes: ["support"],
            async getKeys() {
              return []
            },
            async getItem(key: string) {
              return { content: "", key }
            },
          },
        },
      },
      driver: { model: {} as never },
    })

    defineAgent({
      // @ts-expect-error Wrapped Workspace Sources do not own access scopes.
      workspace: {
        sources: {
          wrapped: {
            source: {
              scopes: ["support"],
              async getKeys() {
                return []
              },
              async getItem(key: string) {
                return { content: "", key }
              },
            },
          },
        },
      },
      driver: { model: {} as never },
    })

    const capabilityWithScopedSource = defineCapability({
      id: "scoped-source",
      workspaceSources: {
        docs: {
          source: {
            scopes: ["support"],
            async getKeys() {
              return []
            },
            async getItem(key: string) {
              return { content: "", key }
            },
          },
        },
      },
    })
    defineAgent({
      // @ts-expect-error Capability-contributed Workspace Sources do not own access scopes.
      workspace: { sources: {} },
      capabilities: [capabilityWithScopedSource],
      driver: { model: {} as never },
    })

    // @ts-expect-error Workspace Sources do not own access scopes.
    githubSource({
      repo: "acme/docs",
      scopes: ["customer"] as const,
    })

    // @ts-expect-error GitHub Channel PR comments are configured through pullRequest, not legacy events.
    github({ events: { pullRequestComments: true } })

    defineAgent({
      channels: {
        github: () => github({ app: true, pullRequest: true }),
      },
      driver: { run: () => "ok" },
    })
    github({ pullRequest: { workspace: true } })
    github({ pullRequest: { workspace: false } })
    github({ pullRequest: { workspace: { mount: "portal" } } })

    const inferredWorkspace = defineCapability({
      id: "inferred-workspace",
      workspace: {
        sources: {
          docs: file("README.md"),
        },
      },
    })
    defineAgent({
      capabilities: [inferredWorkspace],
      driver: { run: () => "ok" },
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
          docs: githubSource({ repo: "acme/docs" }),
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

    defineAgent({
      workspace: {
        sources: {
          docs: githubSource({ repo: "acme/docs" }),
        },
      },
      capabilities: [widenedAccessCapability],
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
          docs: githubSource({ repo: "acme/docs" }),
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
              expectTypeOf(actor.kind).toEqualTypeOf<"anonymous" | "chat" | (string & {}) | undefined>()
              expectTypeOf(invoker.kind).toEqualTypeOf<"anonymous" | "chat" | (string & {}) | undefined>()
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
          prepare({ actor, channel, invoker }) {
            expectTypeOf(channel?.meta?.customer).toEqualTypeOf<string | undefined>()
            expectTypeOf(channel?.run?.origin).toEqualTypeOf<string | undefined>()
            expectTypeOf(channel?.user?.email).toEqualTypeOf<string | undefined>()
            expectTypeOf(actor.id).toEqualTypeOf<string>()
            expectTypeOf(invoker.id).toEqualTypeOf<string>()
          },
        },
        defineCapability({
          id: "internal-context-filter",
          prepare(context) {
            // @ts-expect-error legacy namespaced values stay on context.context
            expectTypeOf(context["chat.secret"]).toBeString()
          },
        }),
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
    const capabilityScorer: AgentScorer = hasCapabilityExtension("chat")
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
        expectTypeOf(observation.extensions?.get<AgentChatFinishExtension>("chat")).toEqualTypeOf<AgentChatFinishExtension | undefined>()
        expectTypeOf(t.capabilityExtension<{ status: string }>("chat")).toEqualTypeOf<{ status: string } | undefined>()
        expectTypeOf(t.capabilityExtension<string>("chat", "status")).toEqualTypeOf<string | undefined>()
        t.completed()
        t.textContains("ok")
        t.calledTool("lookup")
        t.doesNotCallTool("refund")
        t.hasCapabilityExtension("chat")
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
    expectTypeOf(toAgentRunResult("ok").artifacts).toEqualTypeOf<readonly PublishedAgentDeliveryArtifact[] | undefined>()
    expectTypeOf(streamAgentOutputToEvents("ok")).toEqualTypeOf<AsyncIterable<StreamEvent>>()
  })
})
