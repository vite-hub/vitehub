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
  "avatar-stack": ["AvatarStack"],
  bubble: ["Bubble", "BubbleContent", "BubbleGroup", "BubbleReactions"],
  "code-block": [
    "CodeBlock",
    "CodeBlockActions",
    "CodeBlockContent",
    "CodeBlockCopyButton",
    "CodeBlockFooter",
    "CodeBlockHeader",
    "CodeBlockLine",
    "CodeBlockTitle",
  ],
  "connection-status": ["ConnectionStatus", "ConnectionStatusIndicator", "ConnectionStatusLabel"],
  marker: ["Marker", "MarkerContent", "MarkerIcon"],
  message: ["Message", "MessageAvatar", "MessageContent", "MessageFooter", "MessageGroup", "MessageHeader"],
  "sync-status": ["SyncStatus", "SyncStatusIndicator", "SyncStatusLabel"],
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
  "Chat",
  "ChatMessage",
  "PromptInput",
  "CodeView",
  "FileView",
  "FileDiff",
  "FileTree",
  "Markdown",
  "MessageParts",
  "MultiFileDiff",
  "PatchDiff",
  "ChatSession",
  "ToolList",
  "TraceRun",
  "UnresolvedFile",
  ...partFamilies.attachment,
  ...partFamilies["avatar-stack"],
  ...partFamilies.bubble,
  ...partFamilies["code-block"],
  ...partFamilies["connection-status"],
  ...partFamilies.marker,
  ...partFamilies.message,
  ...partFamilies["sync-status"],
  ...partFamilies.trace,
] as const;

// The import path of a component. Agent views have one path each. The parts of a shadcn/ui family share one path, as in shadcn/ui.
export function componentEntryName(name: string): string {
  for (const [entry, names] of Object.entries(partFamilies))
    if ((names as readonly string[]).includes(name)) return entry;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
