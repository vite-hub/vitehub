import { executeHttpRequest } from "@vite-hub/internal/http-request"
import { posix } from "node:path"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { markLiveWorkspaceSource } from "./config.ts"

import type { WorkspaceContent, WorkspaceSource } from "../core/types.ts"

export type FetchSourceMethod = "GET" | "HEAD" | "POST"
export type FetchSourceResponseType = "json" | "text"

export interface FetchSourceStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface FetchSourceStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface FetchSourceStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => FetchSourceStandardSchemaResultSuccess<T> | FetchSourceStandardSchemaResultFailure | Promise<FetchSourceStandardSchemaResultSuccess<T> | FetchSourceStandardSchemaResultFailure>
  }
}

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "instructions">

export interface FetchSourceRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  method?: FetchSourceMethod
  query?: Record<string, unknown>
  timeout?: number
}

export type FetchSourceRequest = FetchSourceRequestOptions | (() => FetchSourceRequestOptions | Promise<FetchSourceRequestOptions>)

export interface FetchSourceOptions<TResponse = unknown, TOutput = TResponse> extends SourceRuntimeOptions {
  method?: FetchSourceMethod
  path?: string
  request?: FetchSourceRequest
  responseType?: FetchSourceResponseType
  schema?: FetchSourceStandardSchemaV1<TResponse>
  transform?: (data: TResponse) => TOutput | Promise<TOutput>
  url: string | URL
}

export function fetch<TResponse = unknown, TOutput = TResponse>(options: FetchSourceOptions<TResponse, TOutput>): WorkspaceSource {
  const responseType = normalizePublicResponseType(options.responseType || "json")
  const workspacePath = normalizeSafeWorkspacePath(options.path || deriveWorkspacePath(options.url, responseType), { allowEmpty: false })
  const mountPath = posix.dirname(workspacePath) === "." ? "" : posix.dirname(workspacePath)
  const key = mountPath ? workspacePath.slice(mountPath.length + 1) : workspacePath

  return markLiveWorkspaceSource({
    cache: options.cache ?? false,
    fingerprint: {
      method: options.method,
      path: workspacePath,
      responseType,
      url: String(options.url),
    },
    instructions: options.instructions,
    materialize: "lazy",
    mount: mountPath,
    async getKeys() {
      return [key]
    },
    async getItem(sourcePath) {
      if (sourcePath !== key) {
        throw new Error(`[vitehub] Fetch source item does not exist: ${sourcePath}.`)
      }
      const request = typeof options.request === "function" ? await options.request() : options.request
      const result = await executeHttpRequest({
        ...request,
        method: request?.method ?? options.method,
        url: options.url,
      }, {
        responseType,
        schema: options.schema,
      })
      const transformed = options.transform ? await options.transform(result.data as TResponse) : result.data
      return {
        key,
        path: key,
        content: serializeFetchSourceContent(transformed, responseType),
        mediaType: result.mediaType ?? mediaTypeFor(responseType),
        metadata: {
          request: result.summary,
          status: result.status,
        },
      }
    },
    async getMeta(sourcePath) {
      if (sourcePath !== key) return undefined
      return {
        mediaType: mediaTypeFor(responseType),
        request: {
          method: options.method || "GET",
          responseType,
          url: redactedUrl(options.url),
        },
      }
    },
  }, { [workspacePath]: key })
}

function normalizePublicResponseType(responseType: string): FetchSourceResponseType {
  if (responseType !== "json" && responseType !== "text") {
    throw new TypeError(`[vitehub] source.fetch() responseType "${responseType}" is not supported in v1. Use json or text.`)
  }
  return responseType
}

function deriveWorkspacePath(url: string | URL, responseType: FetchSourceResponseType) {
  const parsed = url instanceof URL ? url : new URL(url)
  if (parsed.search) {
    throw new Error("[vitehub] source.fetch() requires an explicit path when the URL includes query parameters.")
  }
  let path = normalizeSafeWorkspacePath(decodeURI(parsed.pathname).replace(/^\/+/, ""), { allowEmpty: false })
  if (!posix.extname(path)) {
    path = `${path}.${responseType === "json" ? "json" : "txt"}`
  }
  return path
}

function serializeFetchSourceContent(value: unknown, responseType: FetchSourceResponseType): WorkspaceContent {
  if (value instanceof Uint8Array) return value
  if (responseType === "json") return JSON.stringify(value, null, 2) ?? "null"
  if (typeof value === "string") return value
  return typeof value === "undefined" ? "" : String(value)
}

function mediaTypeFor(responseType: FetchSourceResponseType) {
  return responseType === "json" ? "application/json" : "text/plain"
}

function redactedUrl(url: string | URL) {
  const parsed = url instanceof URL ? url : new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}
