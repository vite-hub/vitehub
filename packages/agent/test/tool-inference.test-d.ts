import { describe, expectTypeOf, it } from "vitest"
import { tool } from "ai"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { defineCapability } from "../src/capability-runtime.ts"
import type { AgentCapabilityContext, AgentCapabilityRuntimeContext, AgentToolExecutionContext, AgentToolSchema, AgentToolStandardSchema } from "../src/types.ts"

declare const searchSchema: AgentToolSchema<{ query: string }>
declare const sdkSchema: AgentToolStandardSchema<{ query: string }>
declare const countSchema: StandardSchemaV1<string, number> & StandardJSONSchemaV1<string, number>
declare const optionalSchema: AgentToolStandardSchema<{ query?: string } | undefined>

describe("Capability tool schema inference", () => {
  it("infers each inline handler from its schema and preserves its return type", () => {
    const capability = defineCapability({
      id: "search",
      tools: {
        search: {
          name: "search",
          inputSchema: searchSchema,
          execute(input) {
            expectTypeOf(input).toEqualTypeOf<{ query: string }>()
            return { query: input.query }
          },
        },
        count: {
          name: "count",
          inputSchema: countSchema,
          async execute(input) {
            expectTypeOf(input).toEqualTypeOf<number>()
            return input.toFixed()
          },
        },
      },
    })
    expectTypeOf(capability.id).toEqualTypeOf<"search">()
    expectTypeOf(capability.tools.search.execute).returns.toEqualTypeOf<{ query: string }>()
    expectTypeOf(capability.tools.count.execute).returns.toEqualTypeOf<Promise<string>>()
  })

  it("rejects the reproduced schema and handler mismatch", () => {
    defineCapability({
      id: "wrong-input",
      tools: {
        search: {
          name: "search",
          inputSchema: searchSchema,
          // @ts-expect-error The schema produces query, not id.
          execute(input: { id: number }) { return input.id.toFixed() },
        },
      },
    })
    defineCapability({
      id: "wrong-transform-input",
      // @ts-expect-error A transformed schema owns the validated output type.
      tools: { count: { name: "count", inputSchema: countSchema, execute(input: string) { return input.length } } },
    })
  })

  it("keeps optional schema outputs and broader handlers", () => {
    defineCapability({
      id: "optional",
      tools: {
        optional: {
          inputSchema: optionalSchema,
          execute(input) {
            expectTypeOf(input).toEqualTypeOf<{ query?: string } | undefined>()
            return input?.query
          },
        },
        broad: {
          inputSchema: countSchema,
          execute(input: number | string) { return String(input) },
        },
      },
    })
  })

  it("preserves raw JSON Schema, missing schemas, and execution context annotations", () => {
    defineCapability({
      id: "raw",
      tools: {
        raw: {
          name: "raw",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          execute(input: { query: string }) { return input.query },
        },
        noSchema: { name: "noSchema", execute() { return "ok" } },
        context: {
          inputSchema: searchSchema,
          execute(input, context?: AgentToolExecutionContext) {
            expectTypeOf(input).toEqualTypeOf<{ query: string }>()
            return context?.abortSignal?.aborted ? "aborted" : input.query
          },
        },
      },
    })
  })

  it("preserves AI SDK tools and provider-native tool contracts", () => {
    const sdkTool = tool({
      inputSchema: sdkSchema,
      execute(input, options) { return `${options.toolCallId}:${input.query}` },
    })
    const providerTool = { type: "provider" as const, id: "test.search" as const, args: { region: "eu" } }
    const capability = defineCapability({
      id: "provider",
      tools: { sdkTool, providerTool },
    })
    expectTypeOf(capability.tools.sdkTool).toEqualTypeOf<typeof sdkTool>()
    expectTypeOf(capability.tools.providerTool).toEqualTypeOf<typeof providerTool>()
  })

  it("checks annotated resolver handlers and keeps resolver context and optional results", () => {
    defineCapability({
      id: "resolved",
      async tools(context) {
        expectTypeOf(context).toEqualTypeOf<AgentCapabilityContext>()
        if (context.mode === "read") return undefined
        return {
          search: {
            inputSchema: searchSchema,
            execute(input: { query: string }) { return input.query },
          },
        }
      },
    })
    defineCapability({
      id: "wrong-resolver",
      // @ts-expect-error Resolver tools must accept the schema output too.
      tools() {
        return { search: { inputSchema: searchSchema, execute(input: { id: number }) { return input.id } } }
      },
    })
  })

  it("keeps schema inference when runtime config is explicit", () => {
    const define = defineCapability<{ gatewayKey: string }>()
    const capability = define({
      id: "configured",
      resolve(context) {
        expectTypeOf(context).toEqualTypeOf<AgentCapabilityRuntimeContext<{ gatewayKey: string }>>()
      },
      tools: {
        search: { inputSchema: searchSchema, execute(input) { return input.query } },
        optional: {
          inputSchema: optionalSchema,
          execute(input) {
            expectTypeOf(input).toEqualTypeOf<{ query?: string } | undefined>()
            return input?.query
          },
        },
      },
    })
    expectTypeOf(capability.tools.search.execute).parameter(0).toEqualTypeOf<{ query: string }>()
    define({
      id: "wrong-configured",
      // @ts-expect-error Fixing runtime config must not erase the schema input.
      tools: { search: { inputSchema: searchSchema, execute(input: { id: number }) { return input.id } } },
    })
    define({
      id: "wrong-configured-resolver",
      // @ts-expect-error Resolved tools also check the schema output after config is fixed.
      tools(context) {
        expectTypeOf(context).toEqualTypeOf<AgentCapabilityContext<{ gatewayKey: string }>>()
        return { search: { inputSchema: searchSchema, execute(input: { id: number }) { return input.id } } }
      },
    })
    // @ts-expect-error Partial type arguments disable inference. Use defineCapability<Config>()({...}).
    defineCapability<{ gatewayKey: string }>({ id: "old-form", tools: { search: { inputSchema: searchSchema, execute(input: { id: number }) { return input.id } } } })
  })
})
