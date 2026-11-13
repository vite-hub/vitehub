import { defineCapability, normalizeMode, workspaceMaterializationPathsSymbol } from "../../capability-runtime.ts"
import { publishWorkspaceArtifacts, rewriteDeliveryArtifactMarkdown } from "../../delivery-artifacts.ts"
import { toAgentRunResult } from "../../agent-output.ts"
import {
  readActiveAgentWorkspaceFile,
  readAgentWorkspaceDiff,
} from "../../agent-workspace-runtime.ts"
import { cloneWithPropertyDescriptors } from "../../internal/stream-result.ts"
import { loadAgentWorkflowBlobPrimitive } from "../../internal/workflow-runtime-loaders.ts"
import { attachmentStringBytes, currentInputAttachments, isAttachmentBlob, isAttachmentData, resolveAttachmentData } from "../../messages.ts"
import { defineInternalTool, jsonObjectSchema, requirePrimitive } from "../internal.ts"
import {
  assertString,
  method,
  selectStore,
  storageValue,
} from "./shared.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityContext,
  AgentCapabilityMode,
  AgentToolSet,
  MaybePromise,
} from "../../types.ts"
import type { AttachmentPart } from "../../messages.ts"
import type { PrimitiveStorageCapabilityOptions } from "./shared.ts"
import { agentDiagnostics } from "../../agent-diagnostics.ts"

export interface BlobCapabilityOptions extends PrimitiveStorageCapabilityOptions {
  assetPaths?: boolean | string | readonly string[]
  /** Limits `blob_read` and `blob_edit` to pathnames under this folder, such as `reports/`. */
  prefix?: string
}

export function blob(options: BlobCapabilityOptions = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Blob")
  const assetPaths = normalizeAssetPaths(mode, options.assetPaths)
  const scope = blobScope(options.prefix)
  return Object.assign(defineCapability({
    id: "blob",
    mode,
    output(context) {
      if (context.driver?.kind !== "provider" || !assetPaths.length) return
      context.output.final(
        async result => await publishReferencedAgentArtifacts(result, context, assetPaths, options),
        { order: "last" },
      )
    },
    requires: [{ primitive: "blob" }],
    tools: blobTools(mode, options, scope),
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

// The Blob primitive decodes a pathname once and drops leading slashes before a driver sees it.
function decodeBlobPathname(pathname: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    decoded = pathname
  }
  return decoded.replace(/^\/+/, "")
}

function hasBlobDotSegment(pathname: string): boolean {
  return pathname.split(/[/\\]/).some(segment => segment === "." || segment === "..")
}

function blobScope(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return
  const scope = typeof prefix === "string" ? prefix.trim().replace(/\/+/g, "/").replace(/^\/|\/$/g, "") : ""
  if (!scope || hasBlobDotSegment(scope) || scope.includes("\\") || /%[\da-f]{2}/i.test(scope)) {
    throw agentDiagnostics.AGENT_R1044({ capability: "blob", prefix })
  }
  return scope
}

/** Checks a pathname as the Blob primitive resolves it, after decoding. */
function inBlobScope(pathname: string, scope: string): boolean {
  return pathname.startsWith(`${scope}/`) && !hasBlobDotSegment(pathname)
}

function assertBlobScope(pathname: string, scope: string | undefined, label: string): string {
  if (scope !== undefined && !inBlobScope(decodeBlobPathname(pathname), scope)) {
    throw agentDiagnostics.AGENT_R1045({ label, prefix: `${scope}/`, value: pathname })
  }
  return pathname
}

/** `put()` removes empty filename segments before joining `options.prefix`. A random suffix only changes the filename. */
function assertBlobPutScope(pathname: string, putOptions: Record<string, unknown> | undefined, scope: string | undefined): void {
  if (scope === undefined) return
  const putPrefix = putOptions?.prefix
  const joined = [typeof putPrefix === "string" ? putPrefix : "", decodeBlobPathname(pathname).split("/").filter(Boolean).join("/")]
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
  if ((putPrefix !== undefined && typeof putPrefix !== "string") || !inBlobScope(joined, scope)) {
    throw agentDiagnostics.AGENT_R1045({ label: "blob_edit pathname", prefix: `${scope}/`, value: joined })
  }
}

function blobScopeNote(scope: string | undefined): string {
  return scope === undefined ? "" : ` Every pathname must start with "${scope}/".`
}

/** Returns the prefix to list. Inside a scope, the prefix defaults to the scope and must stay under it. */
function scopedBlobListPrefix(prefix: unknown, scope: string | undefined): string {
  if (scope === undefined) return assertString(prefix, "blob_read prefix")
  if (prefix === undefined || prefix === "") return `${scope}/`
  const value = assertString(prefix, "blob_read prefix")
  if (decodeBlobPathname(value).replace(/\/+$/, "") === scope) return `${scope}/`
  return assertBlobScope(value, scope, "blob_read prefix")
}

function scopedBlobList(result: unknown, scope: string | undefined): unknown {
  if (scope === undefined || typeof result !== "object" || result === null) return result
  const list = result as { blobs?: unknown, folders?: unknown }
  return {
    ...list,
    ...(Array.isArray(list.blobs)
      ? { blobs: list.blobs.filter((object: { pathname?: unknown }) => typeof object?.pathname === "string" && inBlobScope(object.pathname, scope)) }
      : {}),
    ...(Array.isArray(list.folders)
      ? { folders: list.folders.filter((folder: unknown) => typeof folder === "string" && inBlobScope(folder, scope)) }
      : {}),
  }
}

function normalizeAssetPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")
  const parts = normalized.split("/").filter(Boolean)
  if (!normalized || parts.some(part => part === "." || part === "..")) {
    throw agentDiagnostics.AGENT_R0200({ message: `[vitehub] Blob asset path must be a workspace-relative path: "${path}".` })
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

function referencedAgentArtifacts(text: string, roots: readonly string[], changedPaths: ReadonlySet<string>) {
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
  if (!url) throw agentDiagnostics.AGENT_R0201({ message: "[vitehub] Blob asset publication requires Blob serving or a driver that returns a public URL." })
  try {
    return new URL(url).href
  }
  catch {
    // Console RPC uses a synthetic request URL. Keep its Blob URLs relative to the UI host.
    if (request && new URL(request.url).hostname === "vitehub.local") return url
    if (request) return new URL(url, request.url).href
    throw agentDiagnostics.AGENT_R0202({ message: "[vitehub] Blob asset publication returned a relative URL without an Agent request URL." })
  }
}

async function artifactRunPathSegment(runId: string | undefined): Promise<string> {
  if (!runId) return globalThis.crypto.randomUUID()
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function publishReferencedAgentArtifacts(
  result: unknown,
  context: Parameters<NonNullable<AgentCapabilityDefinition["output"]>>[0],
  assetPaths: readonly string[],
  options: BlobCapabilityOptions,
): Promise<unknown> {
  const diff = readAgentWorkspaceDiff(context.context)
  if (!diff) return result

  const runResult = toAgentRunResult(result)
  if (!runResult.text) return result
  const changedPaths = new Set(diff.entries.flatMap(entry =>
    (entry.type === "added" || entry.type === "modified") && entry.after?.type === "file" ? [entry.path] : [],
  ))
  const artifacts = referencedAgentArtifacts(runResult.text, assetPaths, changedPaths)
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
      text: { configurable: true, enumerable: true, value: rewriteDeliveryArtifactMarkdown(runResult.text, published), writable: true },
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
    text: rewriteDeliveryArtifactMarkdown(runResult.text, published),
    artifacts: nextArtifacts,
  }
}

function normalizeListLimit(limit: unknown): number {
  if (limit === undefined) return defaultListLimit
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw agentDiagnostics.AGENT_R0203({ message: "[vitehub] list limit must be a positive number." })
  }
  return Math.min(Math.floor(limit), maxListLimit)
}

async function resolveBlobPrimitive(context: AgentCapabilityContext) {
  if (context.capabilities?.blob !== undefined) return requirePrimitive(context as never, "blob")
  try {
    return await loadAgentWorkflowBlobPrimitive()
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0204({ message: `[vitehub] Capability "blob" requires the blob primitive to be configured or @vite-hub/blob to be installed. ${error instanceof Error ? error.message : String(error)}` })
  }
}

async function resolveBlobStore(context: AgentCapabilityContext, options: BlobCapabilityOptions) {
  return selectStore(await resolveBlobPrimitive(context), "Blob", options.store)
}

async function readWorkspaceBlobBody(context: AgentCapabilityContext, path: string) {
  const activeRead = await readActiveAgentWorkspaceFile(context.context, path)
  if (activeRead) {
    if (activeRead.body !== undefined) return activeRead.body
    throw agentDiagnostics.AGENT_R0205({ message: `[vitehub] blob_edit workspacePath was not found in the active Agent Workspace Session: "${path}".` })
  }
  if (!context.fs?.readFile) throw agentDiagnostics.AGENT_R0206({ message: "[vitehub] blob_edit workspacePath requires a Workspace file system." })
  return await context.fs.readFile(path as never, { encoding: "binary" })
}

function resolvableInputAttachments(context: AgentCapabilityContext): AttachmentPart[] {
  if (!context.invocation) return []
  return currentInputAttachments(context.invocation.input.messages(), context.run?.messageId)
    .filter(part => isAttachmentData(part.data) || typeof part.fetchData === "function")
}

async function readInputAttachment(context: AgentCapabilityContext, id: string) {
  const attachments = resolvableInputAttachments(context)
  const matches = attachments.filter(part => part.id === id)
  if (matches.length !== 1) {
    const available = attachments.flatMap(part => part.id ? [part.id] : [])
    throw agentDiagnostics.AGENT_R0207({ message: `[vitehub] blob_edit attachmentId ${JSON.stringify(id)} must identify one current input attachment.${available.length ? ` Available: ${available.join(", ")}.` : ""}` })
  }
  const attachment = matches[0]!
  const body = await resolveAttachmentData(attachment)
  if (!isAttachmentData(body)) {
    throw agentDiagnostics.AGENT_R0208({ message: `[vitehub] blob_edit attachmentId ${JSON.stringify(id)} did not resolve to supported attachment data.` })
  }
  return { body: typeof body === "string" ? attachmentStringBytes(body, attachment.mediaType) : isAttachmentBlob(body) ? new Uint8Array(await body.arrayBuffer()) : body, mediaType: attachment.mediaType }
}

function blobTools(mode: AgentCapabilityMode, options: BlobCapabilityOptions, scope: string | undefined): AgentCapabilityDefinition["tools"] {
  return (context) => {
    const attachments = resolvableInputAttachments(context)
      .flatMap(part => part.id ? [`${part.id} (${part.mediaType})`] : [])
    const tools: AgentToolSet = {
      blob_read: defineInternalTool<BlobReadInput>({
        description: `Read one Blob object, read object metadata, or list objects under a prefix.${blobScopeNote(scope)}`,
        execute: async ({ cursor, folded, limit, operation, pathname, prefix }: BlobReadInput) => {
          const store = await resolveBlobStore(context, options)
          if (operation === "get") return storageValue(method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "get")(assertBlobScope(assertString(pathname, "blob_read pathname"), scope, "blob_read pathname")))
          if (operation === "head") return storageValue(method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "head")(assertBlobScope(assertString(pathname, "blob_read pathname"), scope, "blob_read pathname")))
          if (operation === "list") {
            const scopedPrefix = scopedBlobListPrefix(prefix, scope)
            return scopedBlobList(await storageValue(method<(options?: unknown) => MaybePromise<unknown>>(store, "blob", "list")({ cursor, folded, limit: normalizeListLimit(limit), prefix: scopedPrefix })), scope)
          }
          throw agentDiagnostics.AGENT_R0209({ message: `[vitehub] Unsupported blob_read operation: ${String(operation)}` })
        },
        icon: "i-lucide-hard-drive-download",
        inputSchema: blobReadInputSchema,
        name: "blob_read",
        title: "Read Blob storage",
      }),
    }
    if (mode === "write") {
      tools.blob_edit = defineInternalTool<BlobEditInput>({
        description: [
          `Put or delete Blob objects. Use attachmentId for a current input attachment or workspacePath for a Workspace file.${blobScopeNote(scope)}`,
          ...(attachments.length ? [`Current input attachments: ${attachments.join(", ")}.`] : []),
        ].join(" "),
        execute: async ({ attachmentId, body, operation, options: putOptions, pathname, workspacePath }) => {
          const store = await resolveBlobStore(context, options)
          if (operation === "put") {
            const path = assertString(pathname, "blob_edit pathname")
            assertBlobPutScope(path, putOptions, scope)
            const sourcePath = typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : undefined
            const sourceAttachment = typeof attachmentId === "string" && attachmentId.trim() ? attachmentId : undefined
            const sources = Number(body !== undefined) + Number(Boolean(sourcePath)) + Number(Boolean(sourceAttachment))
            if (sources > 1) throw agentDiagnostics.AGENT_R0210({ message: "[vitehub] blob_edit put accepts exactly one of attachmentId, body, or workspacePath." })
            if (sourceAttachment) {
              const attachment = await readInputAttachment(context, sourceAttachment)
              return storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(
                path,
                attachment.body,
                { ...putOptions, ...(attachment.mediaType ? { contentType: attachment.mediaType } : {}) },
              ))
            }
            if (sourcePath) {
              return storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(path, await readWorkspaceBlobBody(context, sourcePath), putOptions))
            }
            if (body === undefined) throw agentDiagnostics.AGENT_R0211({ message: "[vitehub] blob_edit put requires attachmentId, body, or workspacePath." })
            return storageValue(method<(pathname: string, body: unknown, options?: unknown) => MaybePromise<unknown>>(store, "blob", "put")(path, body, putOptions))
          }
          if (operation === "delete") {
            const path = assertBlobScope(assertString(pathname, "blob_edit pathname"), scope, "blob_edit pathname")
            await storageValue(method<(pathname: string) => MaybePromise<unknown>>(store, "blob", "delete")(path))
            return { pathname: path, deleted: true }
          }
          throw agentDiagnostics.AGENT_R0212({ message: `[vitehub] Unsupported blob_edit operation: ${String(operation)}` })
        },
        icon: "i-lucide-hard-drive-upload",
        inputSchema: blobEditInputSchema,
        name: "blob_edit",
        policy: options.policy,
        title: "Changed Blob storage",
      })
    }
    return tools
  }
}
