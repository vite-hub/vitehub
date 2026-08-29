import { describe, expectTypeOf, it } from "vitest"
import type { LanguageModel } from "ai"

import { defineAgent, defineAgentInvoker, defineCapability, defineFinishEffect, runAgent, runAgentInline, startAgentInvocation, type AgentActor, type AgentCapabilitiesResolverContext, type AgentCallbackContext, type AgentCapabilityCliCommand, type AgentCapabilityCliResolver, type AgentCapabilityDefinition, type AgentChannelDeliveryEffectContext, type AgentChannelDeliveryEffectIntent, type AgentChannelDeliveryEffectKind, type AgentChannelDeliveryFinishEffect, type AgentChannelDeliveryFinishEffectContext, type AgentChannelDefinition, type AgentChannelDeliveryReplyPayload, type AgentChannelDeliveryReplyStream, type AgentChannelFactory, type AgentChannelInput, type AgentChannelInputs, type AgentDeliveryArtifact, type AgentDriver, type AgentDriverAdaptiveCapacityOptions, type AgentDriverCapacityOptions, type AgentDriverCapacityQueueOptions, type AgentErrorHookEvent, type AgentFinishEvent, type AgentFinishHookEvent, type AgentGatewayModel, type AgentHookObserverEvent, type AgentInvoker, type AgentMessageChannelSettings, type AgentMessageDeliveryKind, type AgentModelInput, type AgentModuleOptions, type AgentRunInput, type AgentRunInputContextValues, type AgentRunResult, type AgentRuntimeConfig, type AgentRuntimeContext, type AgentTriggerInvokeResult, type AgentTriggerRunInvokeResult, type AgentUIMessageStreamProjection, type AgentUsageRecord, type ImagePart, type PublishedAgentDeliveryArtifact, type ResolvedAgentRuntimeContext } from "../src/index.ts"
import { createProcessAgentCapacity, type ProcessAgentCapacityOptions } from "../src/runtime/process.ts"
import { access, blob, browser, chat, title, db, email, executor, fetch, getTranscriptionResults, git, inputCommands, kv, mcp, openapi, papercuts, repositoryHost, repositoryHostContext, sandbox, schedule, skills, streamTranscription, subagents, transcribe, cost, vercelAiGatewayPricing, webSearch, workspaceShell, type AgentUsagePricing, type EmailCapabilityOptions, type EmailCapabilityToolPolicy, type ExecutorCapabilityOptions, type PapercutReportContext, type PapercutReportEvent, type SubagentToolInput, type CostOptions, type VercelAiGatewayPricingOptions } from "../src/capabilities.ts"
import { defineChannel, github, http, pullRequest, teams, telegram, webChat, type GitHubPullRequestCommand, type GitHubPullRequestRunContext } from "../src/channels.ts"
import { defineEval, hasCapabilityExtension, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import { streamAgentOutputToEvents, toAgentRunResult } from "../src/output.ts"
import { defineAgentRunEvents, type AgentRunEventPublisher } from "../src/server.ts"
import type { AgentInvocationContextStore, AgentInvokerProfile, AgentOutputExtensionProvider, AgentPublicError, AgentToolDefinition, AgentToolSchema, StreamEvent } from "../src/index.ts"
import type { AgentCapabilitiesInput } from "../src/types.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import githubExtension from "@github-tools/eve-extension"
import { file, github as githubSource, type ReadonlyWorkspaceFacade } from "@vite-hub/workspace"
import type { AccessChatOptions, AccessInvocationContextValue, AccessWorkspaceOptionsFor, AgentChatRunContext, FetchCapabilityToolOptions, RepositoryHostClient, RepositoryHostContextValue, TranscriptionResult } from "../src/capabilities.ts"

declare global {
  interface ViteHubAgentInvocationContextValues {
    "chat.secret": string
    portal: { baseUrl?: string, cubeToken?: string, previewCookie?: string }
    "review.context": { number?: number, repository?: string }
    "support.customerScope": { customers: string[] }
    trustedScope: string
  }
}

describe("agent public types", () => {
  it("requires capabilities in resolved Runtime contexts", () => {
    expectTypeOf<ResolvedAgentRuntimeContext["capabilities"]>().toEqualTypeOf<NonNullable<AgentRuntimeContext["capabilities"]>>()
    expectTypeOf<AgentCallbackContext["capabilities"]>().toEqualTypeOf<NonNullable<AgentRuntimeContext["capabilities"]>>()
  })

  it("preserves native Capability context inference beside Eve mounts", () => {
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const native = defineCapability({ id: "native" }) as AgentCapabilityDefinition<
      AgentRuntimeConfig,
      any,
      { invocationContext: { native: string } }
    >
    defineAgent({
      capabilities: [native, githubExtension({ preset: "code-review" })],
      driver: { run({ context }) {
        expectTypeOf(context.get("native")).toEqualTypeOf<string | undefined>()
        return "ok"
      } },
    })
  })

  it("accepts optional MCP servers without conditional capability arrays", () => {
    const enabled: boolean = false
    const optionalClient: MCPClient | undefined = undefined

    mcp({
      servers: {
        disabled: enabled ? remoteMcpServer({ url: "https://example.com/mcp" }) : false,
        initializeFirst: {
          protocolVersionDiscovery: false,
          transport: { type: "http", url: "https://legacy.example.com/mcp" },
        },
        nullable: () => null,
        optional: optionalClient,
        runtime: async () => undefined,
      },
    })
  })

  it("types static and invocation-resolved Executor connections", () => {
    const credential = { unseal: () => "executor-secret" }
    const connection: ExecutorCapabilityOptions = {
      apiKey: credential,
      url: new URL("https://executor.sh/quiver/mcp"),
    }

    executor(connection)
    const enabled: boolean = false
    executor(enabled ? connection : false)
    executor(null)
    executor(undefined)
    executor(async () => enabled
      ? { apiKey: credential, url: "https://executor.sh/quiver/mcp" }
      : false)
    executor(async () => null)
    executor(async () => undefined)

    executor({ timeout: 5_000, url: "https://executor.sh/quiver/mcp" })

    // @ts-expect-error Executor requires a URL or connection resolver.
    executor({ apiKey: credential })
    // @ts-expect-error Executor credentials must be strings or sealed values.
    executor({ apiKey: 42, url: "https://executor.sh/quiver/mcp" })
    // @ts-expect-error Executor connection timeouts must be numbers.
    executor({ timeout: "soon", url: "https://executor.sh/quiver/mcp" })
  })

  it("types Eve extensions in static capabilities", () => {
    defineAgent({
      capabilities: [githubExtension({ preset: "code-review" })],
      driver: { run: () => "ok" },
    })

    defineAgent({
      // @ts-expect-error arbitrary objects are neither Capabilities nor extension mounts
      capabilities: [{}],
      driver: { run: () => "ok" },
    })

    defineAgent({
      // @ts-expect-error unrelated symbol-bearing objects are not extension mounts
      capabilities: [{ *[Symbol.iterator]() {} }],
      driver: { run: () => "ok" },
    })

    const arbitraryCapabilities: object[] = [{}]
    defineAgent({
      // @ts-expect-error open-ended arrays still validate every Capability
      capabilities: arbitraryCapabilities,
      driver: { run: () => "ok" },
    })

    const readonlyArbitraryCapabilities: readonly object[] = [{}]
    defineAgent({
      // @ts-expect-error readonly open arrays still validate every Capability
      capabilities: readonlyArbitraryCapabilities,
      driver: { run: () => "ok" },
    })

    const typedExtensionCapabilities: AgentCapabilitiesInput = [githubExtension({ preset: "code-review" })]
    defineAgent({
      capabilities: typedExtensionCapabilities,
      driver: { run: () => "ok" },
    })
  })

  it("preserves call options through queued webhook rehydration", () => {
    type Options = { mode: "fresh" }
    type Webhook = NonNullable<AgentTriggerRunInvokeResult<Options>["webhook"]>
    type Rehydrate = NonNullable<Webhook["rehydrate"]>

    expectTypeOf<Awaited<ReturnType<Rehydrate>>>().toMatchTypeOf<AgentTriggerInvokeResult<Options>>()

    const queuedInvocation: AgentTriggerRunInvokeResult<Options> = {
      input: { prompt: "stale", options: { mode: "fresh" } },
      webhook: {
        concurrencyLimit: 1,
        deliveryId: "delivery-queued",
        // @ts-expect-error A refreshed run result must preserve webhook ownership.
        rehydrate: () => ({ input: { prompt: "fresh", options: { mode: "fresh" } } }),
      },
    }
    expectTypeOf(queuedInvocation).toMatchTypeOf<AgentTriggerRunInvokeResult<Options>>()

    const steeringInvocation: AgentTriggerRunInvokeResult<Options> = {
      input: { prompt: "stale", options: { mode: "fresh" } },
      webhook: {
        busy: "steer",
        concurrencyKey: "pull-request:1",
        concurrencyLimit: 1,
        deliveryId: "delivery-steer",
        rehydrate: () => ({
          input: { prompt: "fresh", options: { mode: "fresh" } },
          webhook: { concurrencyLimit: 1, deliveryId: "delivery-steer" },
        }),
      },
    }
    expectTypeOf(steeringInvocation).toMatchTypeOf<AgentTriggerRunInvokeResult<Options>>()

    const inlineInvocation: AgentTriggerRunInvokeResult<Options> = {
      input: { prompt: "stale", options: { mode: "fresh" } },
      // @ts-expect-error Rehydration runs only for invocations persisted with concurrencyLimit.
      webhook: {
        deliveryId: "delivery-inline",
        rehydrate: () => ({
          input: { prompt: "fresh", options: { mode: "fresh" } },
          webhook: { concurrencyLimit: 1, deliveryId: "delivery-inline" },
        }),
      },
    }
    expectTypeOf(inlineInvocation).toMatchTypeOf<AgentTriggerRunInvokeResult<Options>>()
  })

  it("types bounded driver capacity", () => {
    const queue = { maxPending: 20, timeout: 300_000 } satisfies AgentDriverCapacityQueueOptions
    const adaptive = {
      sample: async (context) => {
        expectTypeOf(context.active).toEqualTypeOf<number>()
        expectTypeOf(context.concurrency).toEqualTypeOf<number>()
        expectTypeOf(context.pending).toEqualTypeOf<number>()
        expectTypeOf(context.signal).toEqualTypeOf<AbortSignal>()
        return { concurrency: 1, reason: "host pressure" }
      },
      sampleTimeoutMs: 750,
    } satisfies AgentDriverAdaptiveCapacityOptions
    const capacity = { adaptive, concurrency: 2, queue } satisfies AgentDriverCapacityOptions

    defineAgent({
      driver: {
        capacity,
        run: () => "ok",
      },
    })

    const processOptions = {
      concurrency: 6,
      cpu: { pausePressure: 0.7, resumePressure: 0.1 },
      memory: { perInvocationBytes: 1_073_741_824, reserveBytes: 536_870_912 },
      queue,
      sampleTimeoutMs: 750,
    } satisfies ProcessAgentCapacityOptions
    expectTypeOf(createProcessAgentCapacity(processOptions)).toEqualTypeOf<AgentDriverCapacityOptions>()
  })

  it("types declarative and concrete Agent models", () => {
    const descriptor = { apiKey: "token", id: "zai/glm-5v-turbo" } satisfies AgentGatewayModel
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const concrete = {} as LanguageModel

    defineAgent({ driver: { model: "zai/glm-5v-turbo" } })
    defineAgent({ driver: { model: descriptor } })
    defineAgent({ driver: { model: () => descriptor } })
    defineAgent({ driver: { model: concrete } })
    defineAgent({
      driver: {
        // @ts-expect-error Gateway descriptors require id.
        model: { idd: "zai/glm-5v-turbo" },
      },
    })
  })

  it("types usage cost pricing and finish extensions", () => {
    const pricing = ((context) => {
      expectTypeOf(context.usage).toMatchTypeOf<NonNullable<AgentUsageRecord["usage"]>>()
      return {
        usd: "0.01",
        estimated: true,
        source: "custom",
      }
    }) satisfies AgentUsagePricing
    const options = { pricing } satisfies CostOptions
    const gatewayPricingOptions = { timeout: 5_000 } satisfies VercelAiGatewayPricingOptions

    expectTypeOf(cost(options)).toMatchTypeOf<AgentCapabilityDefinition>()
    expectTypeOf(vercelAiGatewayPricing(gatewayPricingOptions)).toMatchTypeOf<AgentUsagePricing>()
    defineAgent({
      capabilities: [cost(options)],
      driver: { run: () => "ok" },
      hooks: {
        "agent:error"(event) {
          expectTypeOf(event).toMatchTypeOf<AgentErrorHookEvent>()
          expectTypeOf<AgentErrorHookEvent>().toMatchTypeOf<{ error: unknown }>()
          expectTypeOf(event.error).toEqualTypeOf<unknown>()
          expectTypeOf(event.errorMessage).toEqualTypeOf<string>()
          expectTypeOf(event.publicError).toEqualTypeOf<AgentPublicError>()
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
          expectTypeOf(event.extensions.get("cost")).toEqualTypeOf<AgentUsageRecord | undefined>()
          expectTypeOf(event.extensions.get("unregistered")).toEqualTypeOf<unknown>()
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
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        validate: (input: unknown) => ({ value: input as { summary: string, title: string } }),
        vendor: "test",
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        version: 1 as const,
      },
    } satisfies StandardSchemaV1<unknown, { summary: string, title: string }>
    const agent = defineAgent({
      driver: { output: { schema }, run: () => "{}" },
      hooks: {
        "agent:finish"(event) {
          expectTypeOf(event.result).toEqualTypeOf<{ summary: string, title: string } | undefined>()
        },
      },
      runtime: false,
    })
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const result = runAgentInline(agent, {} as AgentRuntimeContext, {})
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const rawResult = runAgentInline(agent, {} as AgentRuntimeContext, {}, { output: "raw" })
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const workflowResult = runAgent(agent, {} as AgentRuntimeContext, {})
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const controlled = startAgentInvocation(agent, {} as AgentRuntimeContext, {})

    expectTypeOf(result).toEqualTypeOf<Promise<Response | { summary: string, title: string }>>()
    expectTypeOf(rawResult).toEqualTypeOf<Promise<unknown>>()
    expectTypeOf<Extract<Awaited<typeof workflowResult>, { id: string }>["result"]>().toEqualTypeOf<AgentRunResult | { summary: string, title: string } | undefined>()
    expectTypeOf<Awaited<typeof controlled>["support"]>().toEqualTypeOf<{ followUp: boolean, respond: boolean, steer: boolean }>()
    expectTypeOf<Extract<Awaited<ReturnType<Awaited<typeof controlled>["inspect"]>>, { outcome: "available" }>["invocation"]["output"]>().toEqualTypeOf<AgentRunResult | Response | { summary: string, title: string } | undefined>()
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

  it("keeps chat and webhook route ownership out of hubAgent options", () => {
    const inspectionRoute: AgentModuleOptions = {
      routes: { inspection: "/internal/agents/[agent]" },
    }
    const chatRoute: AgentModuleOptions = {
      routes: {
        // @ts-expect-error Chat route ownership belongs to webChat().
        chat: true,
      },
    }
    const webhookRoute: AgentModuleOptions = {
      routes: {
        // @ts-expect-error Webhook route ownership belongs to Channels.
        webhooks: true,
      },
    }
    void chatRoute
    void inspectionRoute
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        validate: (input: unknown) => ({ value: input as { message: string } }),
        vendor: "test",
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        validate: (input: unknown) => ({ value: input as { message: string } }),
        vendor: "test",
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        version: 1 as const,
      },
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        validate: (input: unknown) => ({ value: input as { limit?: number } }),
      },
    }
    const outputSchema = {
      "~standard": {
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      id: "invalid-audio-runtime",
    })

    defineCapability({
      id: "invalid-instructions",
      // @ts-expect-error Capability Definitions do not own Agent Driver Instructions.
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
      delivery: "manual",
      durable: true,
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
      expectTypeOf(context.context.get("review.context")).toEqualTypeOf<{ number?: number, repository?: string } | undefined>()
      expectTypeOf(context.context.get("unregistered.context")).toEqualTypeOf<unknown>()
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
          // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
          adapter: () => ({}) as never,
          route: {
            admission: {
              body: {
                "~standard": {
                  validate: (input: unknown) => ({
                    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
                    value: input as { messages: unknown[], tenant: string },
                  }),
                },
              },
              authenticate() {
                return { subject: "customer:acme" }
              },
              context({ auth, body }) {
                expectTypeOf(auth.subject).toEqualTypeOf<string>()
                expectTypeOf(body.tenant).toEqualTypeOf<string>()
              },
            },
          },
          webhooks: { path: "/api/support/chat" },
        }),
        teams: teams({
          // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
            mapInput({ body, event, request }) {
              expectTypeOf(body.messages).toEqualTypeOf<unknown>()
              expectTypeOf(event).toEqualTypeOf<unknown>()
              expectTypeOf(request).toEqualTypeOf<Request>()
              // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
              return { meta: body.meta as Record<string, unknown> }
            },
          },
        }),
        resumableWeb: webChat({
          route: {
            admission: {
              authenticate: () => ({ subject: "customer:acme" }),
            },
            resumable: {
              owner: ({ auth }) => auth.subject,
              scope: "process",
            },
          },
        }),
        web: webChat({
          route: {
            admission: {
              body: {
                "~standard": {
                  validate: (input: unknown) => ({
                    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
                    value: input as { messages: unknown[], meta: { customer: string }, user: { email: string } },
                  }),
                },
              },
              authenticate({ body, event, rawBody, request }) {
                expectTypeOf(body.messages).toEqualTypeOf<unknown>()
                expectTypeOf(event).toEqualTypeOf<unknown>()
                expectTypeOf(rawBody).toEqualTypeOf<string>()
                expectTypeOf(request).toEqualTypeOf<Request>()
                return { invokerProfileId: "customer:acme" }
              },
              context({ auth, body, event, rawBody }) {
                expectTypeOf(auth.invokerProfileId).toEqualTypeOf<string>()
                expectTypeOf(body.meta.customer).toEqualTypeOf<string>()
                expectTypeOf(body.user.email).toEqualTypeOf<string>()
                expectTypeOf(event).toEqualTypeOf<unknown>()
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

    webChat({
      route: {
        // @ts-expect-error Resumable web chat must acknowledge its process-local boundary.
        resumable: { owner: () => "customer:acme" },
      },
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

    // @ts-expect-error Message metadata schemas belong to Agent or Channel definitions, not the legacy chat() Capability.
    // SAFETY: the type fixture needs only the Standard Schema type to verify this rejected legacy option.
    chat({ meta: {} as StandardSchemaV1<unknown, Record<string, unknown>> })
    // @ts-expect-error Message metadata revisions belong to Agent or Channel definitions, not the legacy chat() Capability.
    chat({ metaRevision: "v1" })

    type ServerExports = typeof import("../src/server.ts")
    type _PublicDiscordGatewayRouteHandler = ServerExports["createDiscordGatewayRouteHandler"]
    type _PublicResumableChatRouteContext = import("../src/server.ts").AgentChannelChatRouteResumableContext
    type _PublicResumableChatRouteOptions = import("../src/server.ts").AgentChannelChatRouteResumableOptions
    type _PublicResumableChatRouteRequestBody = import("../src/server.ts").AgentChannelChatRouteResumableRequestBody
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
    access({
      // @ts-expect-error Workspace Scopes do not own Agent Driver Instructions.
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
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // @ts-expect-error Chat adapters belong to Agent Channels.
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
      accountId: string
      invoker?: SupportInvoker
    }
    const supportProfiles: readonly AgentInvokerProfile<{ audience?: "technical", customer?: "acme" }>[] = [
      { id: "support-customer", kind: "customer", meta: { customer: "acme" } },
      { id: "support-technical", kind: "technical", meta: { audience: "technical" } },
    ]
    expectTypeOf(supportProfiles[0]?.meta?.customer).toEqualTypeOf<"acme" | undefined>()
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
    const supportAccess: AccessWorkspaceOptionsFor<
      typeof workspace,
      SupportInputContext,
      AgentRuntimeConfig,
      "support"
    > = {
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
    const supportAccessCapability = access({ workspace: supportAccess })
    type SupportAccessContract = NonNullable<typeof supportAccessCapability["__vitehubTypeContract"]>
    type SupportAccessInputContext = SupportAccessContract["inputContext"]
    expectTypeOf(supportAccessCapability.__vitehubTypeContract?.inputContext).toMatchTypeOf<SupportInputContext | undefined>()
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    expectTypeOf({} as SupportInputContext).toMatchTypeOf<SupportAccessInputContext>()
    expectTypeOf(supportAccessCapability)
      .toMatchTypeOf<AgentCapabilityDefinition<AgentRuntimeConfig, "support">>()

    const structuralSupportAccess = {
      resolve({ input }) {
        expectTypeOf(input.get().context).toEqualTypeOf<SupportInputContext | undefined>()
        return "customer"
      },
    } satisfies AccessWorkspaceOptionsFor<typeof workspace, SupportInputContext, AgentRuntimeConfig, "support">
    const structuralSupportAccessCapability = access({ workspace: structuralSupportAccess })
    expectTypeOf(structuralSupportAccessCapability.__vitehubTypeContract?.inputContext)
      .toMatchTypeOf<SupportInputContext | undefined>()
    expectTypeOf(structuralSupportAccessCapability)
      .toMatchTypeOf<AgentCapabilityDefinition<AgentRuntimeConfig, "support">>()

    interface SupportRuntimeConfig extends AgentRuntimeConfig {
      supportToken: string
    }
    const customSupportAccess: AccessWorkspaceOptionsFor<typeof workspace, SupportInputContext, SupportRuntimeConfig, "support"> = {
      resolve({ input }) {
        expectTypeOf(input.get().context).toEqualTypeOf<SupportInputContext | undefined>()
        return "customer"
      },
    }
    const customSupportAccessCapability = access({ workspace: customSupportAccess })
    expectTypeOf(customSupportAccessCapability.__vitehubTypeContract?.inputContext).toMatchTypeOf<SupportInputContext | undefined>()
    expectTypeOf(customSupportAccessCapability).toMatchTypeOf<AgentCapabilityDefinition<SupportRuntimeConfig, "support">>()

    const customSupportChat: AccessChatOptions<SupportRuntimeConfig> = {
      resolve() {
        return true
      },
    }
    const combinedSupportAccessCapability = access({
      chat: customSupportChat,
      workspace: {
        defaultScope: "customer",
        scopes: { customer: { all: true } },
      },
    })
    expectTypeOf(combinedSupportAccessCapability).toMatchTypeOf<AgentCapabilityDefinition<SupportRuntimeConfig>>()
    type CombinedSupportContext = Parameters<NonNullable<typeof combinedSupportAccessCapability.prepare>>[0]
    type CombinedSupportModel = Exclude<Parameters<CombinedSupportContext["model"]["resolve"]>[0], AgentModelInput | undefined>
    type CombinedSupportModelContext = Parameters<CombinedSupportModel>[0]
    expectTypeOf<CombinedSupportModelContext["runtimeConfig"]>().toEqualTypeOf<SupportRuntimeConfig>()

    defineAgent({
      workspace,
      driver: {
        run() {
          return "ok"
        },
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        supportAccessCapability,
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
      driver: { model: {} as never },
      // @ts-expect-error access source grants are checked against defineAgent({ workspace.sources })
      workspace: {
        sources: {
          docs: file("AGENTS.md"),
        },
      },
    })

    defineAgent({
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
      capabilities: () => [
        access({
          workspace: {
            scopes: {
              customer: { source: "missing" },
            },
          },
        }),
      ] as const,
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
              // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
              return "technical" as const
            },
            scopes: {
              technical: { source: "ingestion" },
            },
          },
        }),
      ],
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
      driver: { model: {} as never },
    })

    // @ts-expect-error Workspace Sources do not own access scopes.
    githubSource({
      repo: "acme/docs",
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
            expectTypeOf(channel?.meta?.customer).toEqualTypeOf<unknown>()
            expectTypeOf(channel?.run?.origin).toEqualTypeOf<string | undefined>()
            expectTypeOf(channel?.user?.email).toEqualTypeOf<unknown>()
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
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        driver: { model: {} as never },
      }),
      scenarios: [{
        input: { prompt: "hello" },
        metadata: { area: "support" },
        name: "hello",
        scorers: [scorer],
      }],
      scorers: [scorer],
      // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
      variants: [{ name: "strict", instructions: "Be strict.", model: {} as AgentModelInput }],
    }

    defineEval(definition)

    defineEval({
      agent: defineAgent({
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
        driver: { model: {} as never },
      }),
      async test(t) {
        const observation = await t.send("hello")
        observation.text.toUpperCase()
        expectTypeOf(observation.extensions?.get("chat")).toEqualTypeOf<unknown>()
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
          // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
        // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
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
