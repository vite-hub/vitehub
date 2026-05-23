import { describe, expectTypeOf, it } from "vitest"

import { defineAgent, inputCommands as rootInputCommands, type AgentRuntimeContext } from "../src/index.ts"
import { bash, blob, db, fetch, inputCommands, kv, mcp, sandbox, skills } from "../src/capabilities.ts"
import { defineEval, textContains, type AgentEvalDefinition, type AgentObservation, type AgentScorer } from "../src/eval.ts"
import { remoteMcpServer } from "../src/mcp.ts"
import { stdioMcpServer } from "../src/mcp/stdio.ts"
import type { AgentUsageRecord } from "../src/index.ts"
import type { MCPClient } from "@ai-sdk/mcp"
import type { FetchCapabilityToolOptions } from "../src/capabilities.ts"

describe("agent public types", () => {
  it("accepts capabilities from the capabilities entry", () => {
    defineAgent({
      capabilities: [
        bash(),
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
        {
          id: "custom",
          requires: [{ primitive: "workspace", workspace: { paths: ["CONTEXT.md"], required: true } }],
          tools: {
            lookup: { name: "lookup" },
          },
        },
      ],
      adapter: "ai-sdk",
      model: {} as never,
      workspace: { mode: "read" },
    })

    // @ts-expect-error model agents must select an explicit adapter
    defineAgent({
      model: {} as never,
    })

    defineAgent({
      adapter: "ai-sdk",
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
      adapter: "ai-sdk",
      model: {} as never,
    })

    defineAgent({
      adapter: "ai-sdk",
      model: {} as never,
      // @ts-expect-error root-level tools are not public API
      tools: {},
    })

    defineAgent({
      adapter: "ai-sdk",
      model: {} as never,
      // @ts-expect-error workspace mode must be read or write
      workspace: { mode: "mutable" },
    })

    defineAgent({
      adapter: "ai-sdk",
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

    rootInputCommands({
      commands: {
        review: {
          description: "Review the request.",
          run: () => undefined,
        },
      },
    })
  })

  it("accepts agent eval definitions", () => {
    const scorer: AgentScorer = textContains("ok")
    const definition: AgentEvalDefinition = {
      agent: defineAgent({
        adapter: "ai-sdk",
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
      adapter: "ai-sdk",
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
        adapter: "ai-sdk",
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
