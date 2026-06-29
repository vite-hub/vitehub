import type { PublishedAgentDeliveryArtifact } from "./types.ts"
import type { Attachment } from "chat"

const chatImageArtifactExtensions = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"])

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
