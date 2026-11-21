import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as ui from "../src/index.ts";
import { WorkspaceFileLink } from "../src/workspace/workspace-file-link.ts";
import { WorkspaceGuide } from "../src/workspace/workspace-guide.ts";
import { WorkspaceIssues } from "../src/workspace/workspace-issues.ts";
import { WorkspaceSteps } from "../src/workspace/workspace-steps.ts";
import { WorkspaceTask } from "../src/workspace/workspace-task.ts";

// Each public component maps to the docs page that documents it. A new component needs a page here.
const pages: Record<string, string> = {
  Chat: "chat",
  ChatMessage: "chat-message",
  PromptInput: "prompt-input",
  CodeView: "code-view",
  FileView: "code-view",
  FileDiff: "diff",
  FileTree: "file-tree",
  DeviceFrame: "device-frame",
  PlaygroundRender: "playground-render",
  Markdown: "markdown",
  MessageParts: "message-parts",
  MultiFileDiff: "diff",
  PatchDiff: "diff",
  ChatSession: "chat-session",
  AgentSession: "agent-session",
  AgentSessionDetailsRow: "agent-session",
  AgentSessionDetailsSection: "agent-session",
  AgentSessionTimeline: "agent-session",
  AgentSessionWorkGroup: "agent-session",
  FilterSearch: "filter-search",
  ChoicesInput: "filter-search",
  ChoicesInputClear: "filter-search",
  ChoicesInputError: "filter-search",
  ChoicesInputField: "filter-search",
  ChoicesInputStatus: "filter-search",
  ToolList: "tool-list",
  TraceRun: "trace",
  UnresolvedFile: "diff",
  Attachment: "attachment",
  AttachmentAction: "attachment",
  AttachmentActions: "attachment",
  AttachmentContent: "attachment",
  AttachmentDescription: "attachment",
  AttachmentGroup: "attachment",
  AttachmentMedia: "attachment",
  AttachmentTitle: "attachment",
  AttachmentTrigger: "attachment",
  AvatarStack: "avatar-stack",
  Bubble: "bubble",
  BubbleContent: "bubble",
  BubbleGroup: "bubble",
  BubbleReactions: "bubble",
  CodeBlock: "code-block",
  CodeBlockActions: "code-block",
  CodeBlockContent: "code-block",
  CodeBlockCopyButton: "code-block",
  CodeBlockFooter: "code-block",
  CodeBlockHeader: "code-block",
  CodeBlockLine: "code-block",
  CodeBlockTitle: "code-block",
  CopyButton: "copy-button",
  CommentComposer: "comments",
  CommentFilters: "comments",
  CommentLayer: "comments",
  CommentList: "comments",
  CommentPanel: "comments",
  CommentPin: "comments",
  CommentReply: "comments",
  CommentSelectionBar: "comments",
  CommentThread: "comments",
  CommentToolbar: "comments",
  Marker: "marker",
  MarkerContent: "marker",
  MarkerIcon: "marker",
  DropField: "motion",
  HoldToDelete: "motion",
  Message: "message",
  MorphText: "motion",
  MotionList: "motion",
  Progress: "motion",
  RollNumber: "motion",
  SwapIcon: "motion",
  MessageAvatar: "message",
  MessageContent: "message",
  MessageFooter: "message",
  MessageGroup: "message",
  MessageHeader: "message",
  MessageScrollerButton: "message-scroller",
  MessageScrollerContent: "message-scroller",
  MessageScrollerItem: "message-scroller",
  MessageScroller: "message-scroller",
  MessageScrollerViewport: "message-scroller",
  ConnectionStatus: "connection-status",
  ConnectionStatusIndicator: "connection-status",
  ConnectionStatusLabel: "connection-status",
  RelativeTime: "relative-time",
  Status: "status",
  SyncStatus: "sync-status",
  SyncStatusIndicator: "sync-status",
  SyncStatusLabel: "sync-status",
  Trace: "trace",
  TraceCollapsible: "trace",
  TraceCollapsibleContent: "trace",
  TraceCollapsibleTrigger: "trace",
  TraceDescription: "trace",
  TraceIcon: "trace",
  TraceLine: "trace",
  TraceTitle: "trace",
};

const docsRoot = resolve(import.meta.dirname, "../../../docs/content/docs/ui");

function isComponent(value: unknown): value is { emits?: Record<string, unknown> | string[]; name?: string; props?: Record<string, unknown> } {
  return value instanceof Object && "setup" in value && "name" in value;
}

function documentedNames(page: string, heading: string): Set<string> {
  const source = readFileSync(resolve(docsRoot, `${page}.md`), "utf8");
  const names = new Set<string>();
  for (const section of source.split(/\n#### /).slice(1)) {
    if (!section.startsWith(heading)) continue;
    for (const match of section.matchAll(/^\| `([^`]+)`/gm)) names.add(match[1]!);
  }
  return names;
}

describe("UI docs stay in sync with the public components", () => {
  const components = Object.entries(ui).flatMap(([name, component]) => isComponent(component) ? [[name, component] as const] : []);

  it("maps every public component to a docs page", () => {
    const pageNames = new Set(readdirSync(docsRoot).filter(file => file.endsWith(".md")).map(file => file.slice(0, -3)));
    for (const [name] of components) {
      expect(pages[name], `${name} needs a docs page in packages/ui/test/docs-sync.test.ts`).toBeDefined();
      expect(pageNames.has(pages[name]!), `${pages[name]}.md should exist`).toBe(true);
    }
  });

  it.each(components.map(([name, component]) => [name, component] as const))("documents every prop and event of %s", (name, component) => {
    const page = pages[name]!;
    const props = documentedNames(page, "Props");
    const events = documentedNames(page, "Events");
    for (const prop of Object.keys(component.props ?? {})) {
      expect(props.has(prop), `${page}.md should document the ${prop} prop of ${name}`).toBe(true);
    }
    const emits = Array.isArray(component.emits) ? component.emits : Object.keys(component.emits ?? {});
    for (const event of emits) {
      if (event.startsWith("update:")) continue;
      expect(events.has(event), `${page}.md should document the ${event} event of ${name}`).toBe(true);
    }
  });
});

// The learn parts of the workspace entry share one page.
describe("UI docs stay in sync with the learn parts of the workspace", () => {
  const learnParts = { WorkspaceFileLink, WorkspaceGuide, WorkspaceIssues, WorkspaceSteps, WorkspaceTask };

  it.each(Object.entries(learnParts))("documents every prop and event of %s on workspace-guide.md", (name, component) => {
    const source = readFileSync(resolve(docsRoot, "workspace-guide.md"), "utf8");
    const section = source.split(`\n### ${name}\n`)[1]?.split("\n### ")[0] ?? "";
    expect(section, `workspace-guide.md should have a ${name} section`).not.toBe("");
    for (const prop of Object.keys(component.props)) expect(section, `${name} prop ${prop}`).toContain(`| \`${prop}\` |`);
    for (const event of Object.keys(component.emits ?? {})) expect(section, `${name} event ${event}`).toContain(`| \`${event}\` |`);
  });
});
