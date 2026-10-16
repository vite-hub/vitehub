// Parts of a family share one import path, as in shadcn/ui.
const partFamilies = {
  "avatar-stack": ["AvatarStack"],
  "connection-status": ["ConnectionStatus", "ConnectionStatusIndicator", "ConnectionStatusLabel"],
  "sync-status": ["SyncStatus", "SyncStatusIndicator", "SyncStatusLabel"],
} as const;

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
  ...partFamilies["avatar-stack"],
  ...partFamilies["connection-status"],
  ...partFamilies["sync-status"],
] as const;

export function componentEntryName(name: string): string {
  for (const [entry, names] of Object.entries(partFamilies))
    if ((names as readonly string[]).includes(name)) return entry;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
