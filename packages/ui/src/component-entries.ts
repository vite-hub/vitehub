// Parts follow the names of the shadcn/ui agentic components: https://ui.shadcn.com/docs/changelog/2026-10-ai-elements
const partFamilies = {
  attachment: [
    "Attachment",
    "AttachmentAction",
    "AttachmentActions",
    "AttachmentContent",
    "AttachmentDescription",
    "AttachmentGroup",
    "AttachmentMedia",
    "AttachmentTitle",
    "AttachmentTrigger",
  ],
  bubble: ["Bubble", "BubbleContent", "BubbleGroup", "BubbleReactions"],
  marker: ["Marker", "MarkerContent", "MarkerIcon"],
  message: ["Message", "MessageAvatar", "MessageContent", "MessageFooter", "MessageGroup", "MessageHeader"],
  trace: [
    "Trace",
    "TraceCollapsible",
    "TraceCollapsibleContent",
    "TraceCollapsibleTrigger",
    "TraceDescription",
    "TraceIcon",
    "TraceLine",
    "TraceTitle",
  ],
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
  ...partFamilies.attachment,
  ...partFamilies.bubble,
  ...partFamilies.marker,
  ...partFamilies.message,
  ...partFamilies.trace,
] as const;

// The import path of a component. Agent views have one path each. The parts of a shadcn/ui family share one path, as in shadcn/ui.
export function componentEntryName(name: string): string {
  for (const [entry, names] of Object.entries(partFamilies))
    if ((names as readonly string[]).includes(name)) return entry;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
