import type { Attachment } from "chat"
import type {
  AgentChannelDeliveryEffectContext,
  AgentDeliveryArtifact,
  AgentRuntimeConfig,
  MaybePromise,
  PublishedAgentDeliveryArtifact,
} from "./types.ts"

export interface AgentDeliveryArtifactPublishInput {
  artifact: AgentDeliveryArtifact
  content: Uint8Array
  mediaType?: string
  pathname: string
}

export interface AgentDeliveryArtifactPublishResult {
  channelAttachmentId?: string
  url?: string
}

export type AgentDeliveryArtifactPublisher =
  (input: AgentDeliveryArtifactPublishInput) => MaybePromise<AgentDeliveryArtifactPublishResult>

export interface PublishWorkspaceArtifactsOptions {
  prefix?: string
  publish: AgentDeliveryArtifactPublisher
}

const chatImageArtifactExtensions = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function normalizeDeliveryArtifactPath(path: string, label = "Delivery artifact path"): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/")
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`[vitehub] ${label} must stay inside the workspace: "${path}".`)
  }
  return normalized
}

function joinDeliveryArtifactPath(prefix: string | undefined, path: string): string {
  const cleanPrefix = prefix ? normalizeDeliveryArtifactPath(prefix, "Delivery artifact prefix") : undefined
  return cleanPrefix ? `${cleanPrefix}/${path}` : path
}

function deliveryArtifactFromUnknown(value: unknown): PublishedAgentDeliveryArtifact | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return
  return {
    path: value.path,
    ...(typeof value.alt === "string" ? { alt: value.alt } : {}),
    ...(typeof value.channelAttachmentId === "string" ? { channelAttachmentId: value.channelAttachmentId } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(value.placement === "inline" || value.placement === "attachment" || value.placement === "link" ? { placement: value.placement } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  }
}

export function publishedDeliveryArtifactsFromUnknown(value: unknown): PublishedAgentDeliveryArtifact[] {
  if (!Array.isArray(value)) return []
  return value.map(deliveryArtifactFromUnknown).filter((artifact): artifact is PublishedAgentDeliveryArtifact => Boolean(artifact))
}

function replaceMarkdownArtifactDestinations(
  body: string,
  artifacts: readonly PublishedAgentDeliveryArtifact[],
  replace: (artifact: PublishedAgentDeliveryArtifact, destination: string) => string,
): string {
  const byPath = new Map(artifacts.map((artifact) => {
    try {
      return [normalizeDeliveryArtifactPath(artifact.path), artifact] as const
    }
    catch {
      return undefined
    }
  }).filter((entry): entry is readonly [string, PublishedAgentDeliveryArtifact] => Boolean(entry)))
  if (!byPath.size) return body
  return body.replace(/(!?\[[^\]\r\n]*\]\(\s*)<?([^\s)<>]+)>?(\s*\))/g, (match, start: string, destination: string, end: string) => {
    const workspaceRelative = destination.startsWith("/workspace/")
      ? destination.slice("/workspace/".length)
      : undefined
    const sessionSeparator = workspaceRelative?.indexOf("/") ?? -1
    const sessionRelative = workspaceRelative && sessionSeparator >= 0
      ? workspaceRelative.slice(sessionSeparator + 1)
      : undefined
    let path = workspaceRelative && byPath.has(workspaceRelative)
      ? workspaceRelative
      : sessionRelative && byPath.has(sessionRelative)
        ? sessionRelative
        : undefined
    if (!path) {
      try {
        path = normalizeDeliveryArtifactPath(destination)
      }
      catch {
        return match
      }
    }
    const artifact = byPath.get(path)
    return artifact ? `${start}${replace(artifact, destination)}${end}` : match
  })
}

export function deliveryArtifactMarkdownReferencePaths(
  body: string | undefined,
  artifacts: readonly PublishedAgentDeliveryArtifact[],
): string[] {
  if (!body) return []
  const paths = new Set<string>()
  replaceMarkdownArtifactDestinations(body, artifacts, (artifact, destination) => {
    paths.add(normalizeDeliveryArtifactPath(artifact.path))
    return destination
  })
  return [...paths]
}

export function rewriteDeliveryArtifactMarkdown(
  body: string | undefined,
  artifacts: readonly PublishedAgentDeliveryArtifact[],
): string | undefined {
  if (!body) return body
  return replaceMarkdownArtifactDestinations(body, artifacts, (artifact, destination) => {
    if (!artifact.url) return destination
    const url = artifact.url.replace(/[\r\n<>]+/g, "")
    return url ? `<${url}>` : destination
  })
}

export async function publishWorkspaceArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: Pick<AgentChannelDeliveryEffectContext<TRuntimeConfig>, "workspace">,
  artifacts: readonly AgentDeliveryArtifact[],
  options: PublishWorkspaceArtifactsOptions,
): Promise<PublishedAgentDeliveryArtifact[]> {
  if (!context.workspace) throw new Error("[vitehub] publishWorkspaceArtifacts() requires an Agent delivery context with a Workspace.")

  const published: PublishedAgentDeliveryArtifact[] = []
  for (const artifact of artifacts) {
    const path = normalizeDeliveryArtifactPath(artifact.path)
    const stat = await context.workspace.fs.stat(path).catch(() => undefined)
    const mediaType = artifact.mediaType || (stat?.type === "file" ? stat.mediaType : undefined)
    const content = await context.workspace.fs.readFile(path, { encoding: "binary" })
    const normalized = {
      ...artifact,
      path,
      ...(mediaType ? { mediaType } : {}),
    }
    published.push({
      ...normalized,
      ...await options.publish({
        artifact: normalized,
        content,
        ...(mediaType ? { mediaType } : {}),
        pathname: joinDeliveryArtifactPath(options.prefix, path),
      }),
    })
  }
  return published
}

function deliveryArtifactAttachmentType(artifact: PublishedAgentDeliveryArtifact): Attachment["type"] {
  const mediaType = artifact.mediaType?.toLowerCase()
  if (mediaType?.startsWith("audio/")) return "audio"
  if (mediaType?.startsWith("image/")) return "image"
  if (mediaType?.startsWith("video/")) return "video"
  return chatImageArtifactExtensions.has(artifact.path.split(".").pop()?.toLowerCase() || "") ? "image" : "file"
}

export function deliveryArtifactAttachments(
  artifacts: readonly PublishedAgentDeliveryArtifact[] | undefined,
): Attachment[] {
  return (artifacts || []).flatMap((artifact) => {
    if (!artifact.url || artifact.placement === "link") return []
    return [{
      ...(artifact.mediaType ? { mimeType: artifact.mediaType } : {}),
      name: artifact.path.split("/").pop() || artifact.path,
      type: deliveryArtifactAttachmentType(artifact),
      url: artifact.url,
    }]
  })
}
