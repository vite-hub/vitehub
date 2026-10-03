import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as ui from "../src/index.ts";

// Each public component maps to the docs page that documents it. A new component needs a page here.
const pages: Record<string, string> = {
  AgentCapabilityInspector: "capability-inspector",
  AgentChat: "chat",
  AgentChatMessage: "chat-message",
  AgentChatPrompt: "chat-prompt",
  AgentCodeView: "code-view",
  AgentFile: "code-view",
  AgentFileDiff: "diff",
  AgentFileTree: "file-tree",
  AgentInvocation: "invocation",
  AgentInvocationInspector: "invocation-inspector",
  AgentInvocationList: "invocation-list",
  AgentInvocationTimeline: "timeline",
  AgentMarkdown: "markdown",
  AgentMessageParts: "message-parts",
  AgentMultiFileDiff: "diff",
  AgentPatchDiff: "diff",
  AgentSession: "session",
  AgentToolList: "tool-list",
  AgentTrace: "trace",
  AgentUnresolvedFile: "diff",
  MessageScrollerButton: "message-scroller",
  MessageScrollerContent: "message-scroller",
  MessageScrollerItem: "message-scroller",
  MessageScrollerRoot: "message-scroller",
  MessageScrollerViewport: "message-scroller",
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
