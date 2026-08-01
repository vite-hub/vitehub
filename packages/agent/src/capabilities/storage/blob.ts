import { defineCapability, normalizeMode, workspaceMaterializationPathsSymbol } from "../../capability-runtime.ts"
import { publishWorkspaceArtifacts } from "../../delivery-artifacts.ts"
import { toAgentRunResult } from "../../agent-output.ts"
import {
  clearHarnessWorkspaceDiff,
  readActiveHarnessWorkspaceFile,
  readHarnessWorkspaceDiff,
} from "../../harness-runtime.ts"
import { cloneWithPropertyDescriptors } from "../../internal/stream-result.ts"
import { isAttachmentData, isAttachmentPart } from "../../messages.ts"
import {
  assertString,
  createTool,
  jsonObjectSchema,
  method,
  requirePrimitive,
  selectStore,
  storageValue,
} from "./shared.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityContext,
  AgentCapabilityMode,
  AgentCapabilityRuntimeContext,
  AgentToolSet,
  MaybePromise,
} from "../../types.ts"
import type { AttachmentPart } from "../../messages.ts"
import type { PrimitiveStorageCapabilityOptions } from "./shared.ts"

export interface BlobCapabilityOptions extends PrimitiveStorageCapabilityOptions {
  assetPaths?: boolean | string | readonly string[]
}

export function blob(options: BlobCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  const assetPaths = normalizeAssetPaths(mode, options.assetPaths)
  return Object.assign(defineCapability({
    id: "blob",
    mode,
    output(context) {
      if (context.driver?.kind !== "harness" || !assetPaths.length) return
      context.output.final(
        async result => await publishReferencedHarnessArtifacts(result, context, assetPaths, options),
        { order: "last" },
      )
    },
    requires: [{ primitive: "blob" }],
    tools: blobTools(mode, options),
  }), assetPaths.length
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
  attachmentId?: string
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
  attachmentId: {
    description: "Upload a current input attachment instead of inline body or a Workspace file.",
    type: "string",
  },
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
  if (mode !== "write" || value === undefined || value === false) return []
  const paths = value === true
    ? ["screenshots"]
    : Array.isArray(value)
      ? value
      : [value]
  return [...new Set(paths.map(path => normalizeAssetPath(path)))]
}

function assetReferencePath(value: string, roots: readonly string[]): string | undefined {
  const reference = value.trim().replace(/\\/g, "/")
  if (reference.startsWith("//")) return
  const workspaceRelative = reference.match(/^\/workspace\/(.+)$/)?.[1]
  const sessionRelative = workspaceRelative?.match(/^[^/]+\/(.+)$/)?.[1]
  const candidates = workspaceRelative
    ? [workspaceRelative, ...(sessionRelative ? [sessionRelative] : [])]
    : reference.startsWith("/") ? [] : [reference]
  for (const candidate of candidates) {
    let path: string
    try {
      path = normalizeAssetPath(candidate.replace(/^\.\/+/, ""))
    }
    catch {
      continue
    }
    if (roots.some(root => path === root || path.startsWith(`${root}/`))) return path
  }
}

function referencedHarnessArtifacts(text: string, roots: readonly string[], changedPaths: ReadonlySet<string>) {
  const artifacts = new Map<string, { alt?: string, path: string, placement: "inline" | "link" }>()
  for (const match of text.matchAll(/(!?)\[([^\]\r\n]*)\]\(\s*<?([^\s)<>]+)>?\s*\)/g)) {
    const path = assetReferencePath(match[3], roots)
    if (!path || !changedPaths.has(path)) continue
    const artifact = {
      ...(match[2].trim() ? { alt: match[2].trim() } : {}),
      path,
      placement: match[1] === "!" ? "inline" as const : "link" as const,
    }
    const existing = artifacts.get(path)
    if (!existing || artifact.placement === "inline") artifacts.set(path, artifact)
  }
  return [...artifacts.values()]
}

function absoluteBlobArtifactUrl(value: unknown, request: Request | undefined): string {
  const url = typeof value === "object" && value !== null && typeof (value as { url?: unknown }).url === "string"
    ? (value as { url: string }).url
    : undefined
  if (!url) throw new Error("[vitehub] Blob asset publication requires Blob serving or a driver that returns a public URL.")
  try {
    return new URL(url).href
  }
  catch {
    if (request) return new URL(url, request.url).href
    throw new Error("[vitehub] Blob asset publication returned a relative URL without an Agent request URL.")
  }
}

async function artifactRunPathSegment(runId: string | undefined): Promise<string> {
  if (!runId) return globalThis.crypto.randomUUID()
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function publishReferencedHarnessArtifacts(
  result: unknown,
  context: Parameters<NonNullable<AgentCapabilityDefinition["output"]>>[0],
  assetPaths: readonly string[],
  options: BlobCapabilityOptions,
): Promise<unknown> {
  const diff = readHarnessWorkspaceDiff(context.context)
  clearHarnessWorkspaceDiff(context.context)
  if (!diff) return result

  const runResult = toAgentRunResult(result)
  if (!runResult.text) return result
  const changedPaths = new Set(diff.entries.flatMap(entry =>
    (entry.type === "added" || entry.type === "modified") && entry.after?.type === "file" ? [entry.path] : [],
  ))
  const artifacts = referencedHarnessArtifacts(runResult.text, assetPaths, changedPaths)
  if (!artifacts.length) return result

  const store = await resolveBlobStore(context, options)
  const prefix = `vitehub-agent-artifacts/${await artifactRunPathSegment(context.run?.runId)}`
  const published = await publishWorkspaceArtifacts(context, artifacts, {
    prefix,
    publish: async input => ({
      url: absoluteBlobArtifactUrl(await storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(
        input.pathname,
        input.content,
        input.mediaType ? { contentType: input.mediaType } : undefined,
      )), context.request),
    }),
  })
  const nextArtifacts = [...(runResult.artifacts || []), ...published]
  if (typeof result === "object" && result !== null) {
    return cloneWithPropertyDescriptors(result, {
      artifacts: {
        configurable: true,
        enumerable: true,
        value: nextArtifacts,
        writable: true,
      },
    })
  }
  return {
    ...runResult,
    artifacts: nextArtifacts,
  }
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
  const activeRead = await readActiveHarnessWorkspaceFile(context.context, path)
  if (activeRead) {
    if (activeRead.body !== undefined) return activeRead.body
    throw new Error(`[vitehub] blob_edit workspacePath was not found in the active Harness Workspace Session: "${path}".`)
  }
  if (!context.fs?.readFile) throw new Error("[vitehub] blob_edit workspacePath requires a Workspace file system.")
  return await context.fs.readFile(path as never, { encoding: "binary" })
}

function currentInputAttachments(context: AgentCapabilityRuntimeContext): AttachmentPart[] {
  if (!context.input) return []
  const messages = context.input.messages()
  const current = context.run?.messageId
    ? messages.find(message => message.id === context.run?.messageId)
    : [...messages].reverse().find(message => message.role === "user")
  return current?.parts.filter((part): part is AttachmentPart =>
    isAttachmentPart(part)
    && (isAttachmentData(part.data) || typeof part.fetchData === "function"),
  ) ?? []
}

async function readInputAttachment(context: AgentCapabilityRuntimeContext, id: string) {
  const attachments = currentInputAttachments(context)
  const matches = attachments.filter(part => part.id === id)
  if (matches.length !== 1) {
    const available = attachments.flatMap(part => part.id ? [part.id] : [])
    throw new Error(`[vitehub] blob_edit attachmentId ${JSON.stringify(id)} must identify one current input attachment.${available.length ? ` Available: ${available.join(", ")}.` : ""}`)
  }
  const attachment = matches[0]!
  const body = typeof attachment.fetchData === "function" ? await attachment.fetchData() : attachment.data
  if (!isAttachmentData(body)) {
    throw new Error(`[vitehub] blob_edit attachmentId ${JSON.stringify(id)} did not resolve to supported attachment data.`)
  }
  return { body: decodeAttachmentString(body, attachment.mediaType), mediaType: attachment.mediaType }
}

function decodeAttachmentString(body: AttachmentPart["data"], mediaType: string) {
  if (typeof body !== "string") return body
  const dataUrl = /^data:[^,]*?(;base64)?,(.*)$/is.exec(body)
  if (dataUrl) {
    return dataUrl[1]
      ? Uint8Array.from(atob(dataUrl[2]!), character => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(dataUrl[2]!))
  }
  const normalizedMediaType = mediaType.toLowerCase()
  if (normalizedMediaType.startsWith("text/") || normalizedMediaType === "application/json" || normalizedMediaType.endsWith("+json") || normalizedMediaType.endsWith("+xml")) {
    return body
  }
  return Uint8Array.from(atob(body), character => character.charCodeAt(0))
}

function blobTools(mode: AgentCapabilityMode, options: BlobCapabilityOptions): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const runtimeContext = context as AgentCapabilityRuntimeContext
    const attachments = currentInputAttachments(runtimeContext)
      .flatMap(part => part.id ? [`${part.id} (${part.mediaType})`] : [])
    const tools: AgentToolSet = {
      blob_read: createTool<BlobReadInput>({
        description: "Read one Blob object, read object metadata, or list objects under a developer-provided prefix.",
        execute: async ({ cursor, folded, limit, operation, pathname, prefix }: BlobReadInput) => {
          const store = await resolveBlobStore(context, options)
          if (operation === "get") return storageValue(method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "get")(assertString(pathname, "blob_read pathname")))
          if (operation === "head") return storageValue(method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "head")(assertString(pathname, "blob_read pathname")))
          if (operation === "list") {
            const scopedPrefix = assertString(prefix, "blob_read prefix")
            return storageValue(method<(options?: unknown) => MaybePromise<unknown>>(store, "blob", "list")({ cursor, folded, limit: normalizeListLimit(limit), prefix: scopedPrefix }))
          }
          throw new Error(`[vitehub] Unsupported blob_read operation: ${String(operation)}`)
        },
        inputSchema: blobReadInputSchema,
        name: "blob_read",
      }),
    }
    if (mode === "write") {
      tools.blob_edit = createTool<BlobEditInput>({
        description: [
          "Put or delete Blob objects. Use attachmentId for a current input attachment or workspacePath for a Workspace file.",
          ...(attachments.length ? [`Current input attachments: ${attachments.join(", ")}.`] : []),
        ].join(" "),
        execute: async ({ attachmentId, body, operation, options: putOptions, pathname, workspacePath }) => {
          const store = await resolveBlobStore(context, options)
          if (operation === "put") {
            const path = assertString(pathname, "blob_edit pathname")
            const sourcePath = typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : undefined
            const sourceAttachment = typeof attachmentId === "string" && attachmentId.trim() ? attachmentId : undefined
            const sources = Number(body !== undefined) + Number(Boolean(sourcePath)) + Number(Boolean(sourceAttachment))
            if (sources > 1) throw new Error("[vitehub] blob_edit put accepts exactly one of attachmentId, body, or workspacePath.")
            if (sourceAttachment) {
              const attachment = await readInputAttachment(runtimeContext, sourceAttachment)
              return storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(
                path,
                attachment.body,
                { ...(attachment.mediaType ? { contentType: attachment.mediaType } : {}), ...putOptions },
              ))
            }
            if (sourcePath) {
              return storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(path, await readWorkspaceBlobBody(context, sourcePath), putOptions))
            }
            if (body === undefined) throw new Error("[vitehub] blob_edit put requires attachmentId, body, or workspacePath.")
            return storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(path, body, putOptions))
          }
          if (operation === "delete") {
            const path = assertString(pathname, "blob_edit pathname")
            await storageValue(method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "del")(path))
            return { pathname: path, deleted: true }
          }
          throw new Error(`[vitehub] Unsupported blob_edit operation: ${String(operation)}`)
        },
        inputSchema: blobEditInputSchema,
        name: "blob_edit",
        policy: options.policy,
      })
    }
    return tools
  }
}
