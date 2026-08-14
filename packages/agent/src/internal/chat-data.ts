export type AgentChatStreamedPart = {
  data?: unknown
  id?: unknown
  transient?: unknown
  type?: unknown
}

export function updateAgentChatStreamedParts(
  parts: AgentChatStreamedPart[],
  part: AgentChatStreamedPart,
): AgentChatStreamedPart[] {
  if (typeof part.type !== "string" || !part.type.startsWith("data-")) return parts
  const retained = parts.filter(streamed => streamed.type !== part.type)
  return part.transient === true ? [...retained, part] : retained
}
