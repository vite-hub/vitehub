import { defineCapability, normalizeMode } from "../../capability-runtime.ts"
import {
  assertString,
  createTool,
  jsonObjectSchema,
  method,
  requirePrimitive,
  selectStore,
} from "./shared.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
  MaybePromise,
} from "../../types.ts"
import type { PrimitiveStorageCapabilityOptions } from "./shared.ts"

export interface BlobCapabilityOptions extends PrimitiveStorageCapabilityOptions {}

export function blob(options: BlobCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  return defineCapability({ id: "blob", mode, requires: [{ primitive: "blob" }], tools: blobTools(mode, options) })
}

interface BlobReadInput {
  cursor?: string
  folded?: boolean
  limit?: number
  operation: "get" | "head" | "list"
  pathname?: string
  prefix?: string
}

interface BlobEditInput {
  body?: unknown
  operation: "delete" | "put"
  options?: Record<string, unknown>
  pathname: string
}

const defaultListLimit = 25
const maxListLimit = 100

const blobReadInputSchema = jsonObjectSchema({
  cursor: { type: "string" },
  folded: { type: "boolean" },
  limit: { maximum: maxListLimit, minimum: 1, type: "number" },
  operation: { enum: ["get", "head", "list"], type: "string" },
  pathname: { type: "string" },
  prefix: { description: "List Blob objects under this developer-provided prefix.", type: "string" },
}, ["operation"])

const blobEditInputSchema = jsonObjectSchema({
  body: {},
  operation: { enum: ["delete", "put"], type: "string" },
  options: { additionalProperties: true, type: "object" },
  pathname: { type: "string" },
}, ["operation", "pathname"])

function normalizeListLimit(limit: unknown): number {
  if (limit === undefined) return defaultListLimit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw new TypeError("[vitehub] list limit must be a positive number.")
  }
  return Math.min(Math.floor(limit), maxListLimit)
}

function blobTools(mode: AgentCapabilityMode, options: BlobCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const store = selectStore(requirePrimitive(context as never, "blob"), "Blob", options.store)
    const tools: AgentToolSet = {
      blob_read: createTool<BlobReadInput>({
        description: "Read one Blob object, read object metadata, or list objects under a developer-provided prefix.",
        execute: ({ cursor, folded, limit, operation, pathname, prefix }: BlobReadInput) => {
          if (operation === "get") return method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "get")(assertString(pathname, "blob_read pathname"))
          if (operation === "head") return method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "head")(assertString(pathname, "blob_read pathname"))
          if (operation === "list") {
            const scopedPrefix = assertString(prefix, "blob_read prefix")
            return method<(options?: unknown) => MaybePromise<unknown>>(store, "blob", "list")({ cursor, folded, limit: normalizeListLimit(limit), prefix: scopedPrefix })
          }
          throw new Error(`[vitehub] Unsupported blob_read operation: ${String(operation)}`)
        },
        inputSchema: blobReadInputSchema,
        name: "blob_read",
      }),
    }
    if (mode === "write") {
      tools.blob_edit = createTool<BlobEditInput>({
        description: "Put or delete Blob objects.",
        execute: ({ body, operation, options: putOptions, pathname }) => {
          if (operation === "put") return method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(assertString(pathname, "blob_edit pathname"), body, putOptions)
          if (operation === "delete") {
            return method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "del")(assertString(pathname, "blob_edit pathname"))
          }
          throw new Error(`[vitehub] Unsupported blob_edit operation: ${String(operation)}`)
        },
        inputSchema: blobEditInputSchema,
        name: "blob_edit",
        policy: options.policy || "require-approval",
      })
    }
    return tools
  }
}
