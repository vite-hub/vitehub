export const componentNames = [
  "AgentCapabilityInspector",
  "AgentChat",
  "AgentChatMessage",
  "AgentChatPrompt",
  "AgentCodeView",
  "AgentFile",
  "AgentFileDiff",
  "AgentFileTree",
  "AgentInvocation",
  "AgentInvocationInspector",
  "AgentInvocationList",
  "AgentInvocationTimeline",
  "AgentMarkdown",
  "AgentMessageParts",
  "AgentMultiFileDiff",
  "AgentPatchDiff",
  "AgentSession",
  "AgentToolList",
  "AgentTrace",
  "AgentUnresolvedFile",
] as const;

export function componentEntryName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
