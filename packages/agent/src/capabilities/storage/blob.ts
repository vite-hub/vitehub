import { defineCapability, normalizeMode, workspaceMaterializationPathsSymbol } from "../../capability-runtime.ts"
import { readActiveHarnessWorkspaceFile } from "../../harness-runtime.ts"
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
  AgentCapabilityContext,
  AgentCapabilityMode,
  AgentToolSet,
  MaybePromise,
} from "../../types.ts"
import type { PrimitiveStorageCapabilityOptions } from "./shared.ts"

export interface BlobCapabilityOptions extends PrimitiveStorageCapabilityOptions {
  assetPaths?: boolean | string | readonly string[]
}

export function blob(options: BlobCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  const assetPaths = normalizeAssetPaths(mode, options.assetPaths)
  return Object.assign(defineCapability({ id: "blob", mode, requires: [{ primitive: "blob" }], tools: blobTools(mode, options) }), assetPaths.length
    ? { [workspaceMaterializationPathsSymbol]: assetPaths }
    : {})
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
  workspacePath?: string
}

const defaultListLimit = 25
const maxListLimit = 100
const blobPackageName: string = "@vite-hub/blob"

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
  workspacePath: {
    description: "Upload this Workspace file instead of inline body.",
    type: "string",
  },
}, ["operation", "pathname"])

function normalizeAssetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  if (!normalized || parts.some(part => part === "." || part === "..")) {
    throw new TypeError(`[vitehub] Blob asset path must be a workspace-relative path: "${path}".`)
  }
  return parts.join("/")
}

function normalizeAssetPaths(mode: AgentCapabilityMode, value: BlobCapabilityOptions["assetPaths"]): string[] {
  if (mode !== "write" || value === false) return []
  const paths = value === undefined || value === true
    ? ["screenshots"]
    : Array.isArray(value)
      ? value
      : [value]
  return [...new Set(paths.map(path => normalizeAssetPath(path)))]
}

function normalizeListLimit(limit: unknown): number {
  if (limit === undefined) return defaultListLimit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw new TypeError("[vitehub] list limit must be a positive number.")
  }
  return Math.min(Math.floor(limit), maxListLimit)
}

async function resolveBlobPrimitive(context: AgentCapabilityContext) {
  if (context.capabilities?.blob !== undefined) return requirePrimitive(context as never, "blob")
  try {
    return ((await import(blobPackageName)) as { blob: unknown }).blob
  }
  catch (error) {
    throw new Error(`[vitehub] Capability "blob" requires the blob primitive to be configured or @vite-hub/blob to be installed. ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveBlobStore(context: AgentCapabilityContext, options: BlobCapabilityOptions) {
  return selectStore(await resolveBlobPrimitive(context), "Blob", options.store)
}

async function readWorkspaceBlobBody(context: AgentCapabilityContext, path: string) {
  const activeBody = await readActiveHarnessWorkspaceFile(context.context, path)
  if (activeBody !== undefined) return activeBody
  if (!context.fs?.readFile) throw new Error("[vitehub] blob_edit workspacePath requires a Workspace file system.")
  return await context.fs.readFile(path as never, { encoding: "binary" })
}

function blobTools(mode: AgentCapabilityMode, options: BlobCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const tools: AgentToolSet = {
      blob_read: createTool<BlobReadInput>({
        description: "Read one Blob object, read object metadata, or list objects under a developer-provided prefix.",
        execute: async ({ cursor, folded, limit, operation, pathname, prefix }: BlobReadInput) => {
          const store = await resolveBlobStore(context, options)
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
        description: "Put or delete Blob objects. Use workspacePath to upload a Workspace file.",
        execute: async ({ body, operation, options: putOptions, pathname, workspacePath }) => {
          const store = await resolveBlobStore(context, options)
          if (operation === "put") {
            const path = assertString(pathname, "blob_edit pathname")
            const sourcePath = typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : undefined
            if (sourcePath && body !== undefined) throw new Error("[vitehub] blob_edit put accepts body or workspacePath, not both.")
            if (sourcePath) {
              return method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(path, await readWorkspaceBlobBody(context, sourcePath), putOptions)
            }
            if (body === undefined) throw new Error("[vitehub] blob_edit put requires body or workspacePath.")
            return method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(path, body, putOptions)
          }
          if (operation === "delete") {
            const path = assertString(pathname, "blob_edit pathname")
            await method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "del")(path)
            return { pathname: path, deleted: true }
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
