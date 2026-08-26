import {
  executeHttpRequest,
  parseStandardSchema,
} from "@vite-hub/internal/http-request"
import { defineCapability } from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"

import type {
  AgentCapabilityDefinition,
  AgentToolDefinition,
  AgentToolStandardSchema,
  MaybePromise,
} from "../types.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"

export type FetchCapabilityMethod = "GET" | "HEAD" | "POST"
export type FetchCapabilityResponseType = "json" | "text"

export type FetchCapabilityStandardSchemaV1<T = unknown> = StandardSchemaV1<unknown, T>

export interface FetchCapabilityRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  maxResponseBytes?: number
  method?: FetchCapabilityMethod
  query?: Record<string, unknown>
  timeout?: number
}

export interface FetchCapabilityRequestDefinition extends FetchCapabilityRequestOptions {
  url: string | URL
}

export interface FetchCapabilityToolOptions<TInput = unknown, TResponse = unknown, TOutput = TResponse> {
  description?: string
  inputSchema?: AgentToolStandardSchema<TInput>
  method?: FetchCapabilityMethod
  request?: FetchCapabilityToolRequest<TInput>
  responseType?: FetchCapabilityResponseType
  schema?: FetchCapabilityStandardSchemaV1<TResponse>
  transform?: (data: TResponse, input: TInput) => TOutput | Promise<TOutput>
  url?: string | URL
}

export type FetchCapabilityToolRequest<TInput = unknown> =
  | (FetchCapabilityRequestOptions & { url?: string | URL })
  | ((input: TInput) => MaybePromise<FetchCapabilityRequestDefinition | (FetchCapabilityRequestOptions & { url?: string | URL })>)

export interface FetchCapabilityOptions<TTools extends Record<string, FetchCapabilityToolOptions<any, any, any>> = Record<string, FetchCapabilityToolOptions>> {
  tools: TTools
}

function normalizeFetchResponseType(responseType: string | undefined): FetchCapabilityResponseType {
  const normalized = responseType || "json"
  if (normalized !== "json" && normalized !== "text") {
    throw new TypeError(`[vitehub] fetch() responseType "${normalized}" is not supported in v1. Use json or text.`)
  }
  return normalized
}

export function fetch<const TTools extends Record<string, FetchCapabilityToolOptions<any, any, any>>>(options: FetchCapabilityOptions<TTools>): AgentCapabilityDefinition {
  if (!options?.tools || typeof options.tools !== "object" || !Object.keys(options.tools).length) {
    throw new TypeError("[vitehub] fetch({ tools }) requires at least one fetch tool.")
  }
  return defineCapability({
    id: "fetch",
    tools: Object.fromEntries(Object.entries(options.tools).map(([name, toolOptions]) => [
      name,
      createFetchTool(name, toolOptions),
    ])),
  })
}

function createFetchTool(name: string, options: FetchCapabilityToolOptions): AgentToolDefinition {
  return defineInternalTool({
    description: options.description || `Fetch ${name}.`,
    inputSchema: options.inputSchema,
    name,
    async execute(input, context) {
      const parsedInput = options.inputSchema
        ? await parseStandardSchema(options.inputSchema, input, `${name} input`)
        : input
      const request = await resolveFetchToolRequest(options, parsedInput)
      const result = await executeHttpRequest(request, {
        responseType: normalizeFetchResponseType(options.responseType),
        schema: options.schema,
        signal: context?.abortSignal,
      })
      return options.transform
        ? await options.transform(result.data as never, parsedInput as never)
        : result.data
    },
  })
}

async function resolveFetchToolRequest(options: FetchCapabilityToolOptions, input: unknown): Promise<FetchCapabilityRequestDefinition> {
  const request = typeof options.request === "function"
    ? await options.request(input as never)
    : options.request
  const url = request?.url ?? options.url
  if (!url) throw new TypeError("[vitehub] fetch() tool requires a url or request returning a url.")
  return {
    ...request,
    method: request?.method ?? options.method,
    url,
  }
}
