// Every part of `@vite-hub/ui` that renders a Nuxt UI component by name, with fixtures. `main.ts` mounts them with the
// ui-sdk set; `ui-sdk.browser.mjs` drives them. `window.events` records what the parts emit.
import { createCommentsClient, type CommentThread as CommentThreadModel, type CommentUser } from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";
import { defineConnect } from "@vite-hub/web-container/connect";
import type { UIMessage } from "ai";
import { defineComponent, h, ref, type Component } from "vue";

import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentTitle } from "../../../src/components/attachment.ts";
import { AgentSession } from "../../../src/components/agent-session.ts";
import { Chat } from "../../../src/components/chat.ts";
import { CommentList, CommentToolbar } from "../../../src/components/comment-list.ts";
import { CommentPanel } from "../../../src/components/comment-panel.ts";
import { CommentThread } from "../../../src/components/comment-thread.ts";
import { provideComments, useComments } from "../../../src/headless/comments.ts";
import { CopyButton } from "../../../src/components/copy-button.ts";
import { FilterSearch } from "../../../src/components/filter-search.ts";
import { MessageParts } from "../../../src/components/message-parts.ts";
import { PromptInput } from "../../../src/components/prompt-input.ts";
import { TraceRun } from "../../../src/components/trace-run.ts";
import { ConnectPanel } from "../../../src/workspace/connect-panel.ts";
import { PlaygroundContainer } from "../../../src/workspace/playground-container.ts";
import { WorkspacePreview } from "../../../src/workspace/workspace-preview.ts";
import { WorkspaceShell } from "../../../src/workspace/workspace-shell.ts";

declare global {
  interface Window {
    events: string[];
  }
}

window.events = [];
const record = (event: string) => window.events.push(event);

const ana: CommentUser = { id: "ana", name: "Ana Ruiz" };
const pricing = { id: "/pricing", kind: "page" } as const;
const thread: CommentThreadModel = {
  anchor: { kind: "page" },
  author: ana,
  createdAt: 1_000,
  id: "thread-1",
  messages: [{ attachments: [], author: ana, body: "Check the price", createdAt: 1_000, id: "message-1", mentions: [], threadId: "thread-1" }],
  n: 1,
  scope: "page",
  status: "open",
  subject: pricing,
  updatedAt: 1_000,
};
// A 1 by 1 PNG.
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const messages: UIMessage[] = Array.from({ length: 30 }, (_, index) => ({
  id: `message-${index}`,
  parts: [{ text: `Message ${index}. ${"A long line of text. ".repeat(6)}`, type: "text" }],
  role: index % 2 ? "assistant" : "user",
}));
const template = (id: string, label: string) => ({
  files: { "package.json": `{"name":"${id}"}\n`, "server/api/health.get.ts": "export default () => 'ok'\n" },
  id,
  label,
  open: "server/api/health.get.ts",
  snapshot: async () => new Uint8Array([1]),
});

const section = (name: string, content: () => unknown) => h("section", { "aria-label": name, "data-part-name": name }, [h("h2", name), content()]);

const Comments = defineComponent({
  setup() {
    const client = createCommentsClient({ transport: createMemoryTransport({ threads: [thread], user: ana, users: [ana] }), user: ana });
    provideComments(useComments({ client, hotkey: false, subject: pricing }));
    return () => [h(CommentToolbar), h(CommentList, { onSelect: () => record("comment-list:select") })];
  },
});

export const Parts: Component = defineComponent({
  setup() {
    const filter = ref("");
    const choices = {
      abort: () => record("filter:abort"),
      clear: () => { filter.value = ""; },
      error: ref<Error | undefined>(),
      status: ref<"idle" | "ready" | "thinking" | "error">("idle"),
      submit: () => record(`filter:submit:${filter.value}`),
      text: filter,
    };
    const prompt = ref("");
    const commentsClient = createCommentsClient({ transport: createMemoryTransport({ threads: [thread], user: ana, users: [ana] }), user: ana });
    const connect = defineConnect({ vercel: true });
    return () => h("main", [
      section("CopyButton", () => h(CopyButton, { label: "Copy", value: "vitehub", onCopy: () => record("copy") })),
      section("FilterSearch", () => [h(FilterSearch, { choices, label: "Filter sessions" }), h("output", { "data-filter": "" }, filter.value)]),
      section("PromptInput", () => h(PromptInput, {
        modelValue: prompt.value,
        placeholder: "Ask anything",
        "onUpdate:modelValue": (value: string) => { prompt.value = value; },
        onSubmit: () => record(`prompt:submit:${prompt.value}`),
      })),
      section("Attachment", () => h(Attachment, null, () => [
        h(AttachmentContent, () => h(AttachmentTitle, () => "notes.txt")),
        h(AttachmentActions, () => h(AttachmentAction, { "aria-label": "Remove notes.txt", icon: "i-lucide-x", onClick: () => record("attachment:remove") })),
      ])),
      section("MessageParts", () => h(MessageParts, { parts: [{ filename: "pixel.png", mediaType: "image/png", type: "file", url: image }] })),
      section("TraceRun", () => h(TraceRun, {
        defaultOpen: true,
        run: { events: [], id: "run-1", startTime: "2026-11-16T00:00:00.000Z", status: "completed", steps: [{ events: [], id: "step-1", name: "Fetch", startTime: "2026-11-16T00:00:00.000Z", status: "completed", type: "step" }] },
      })),
      section("AgentSession", () => h("div", { style: "height: 320px" }, h(AgentSession, { surfaces: [{ icon: "i-lucide-files", id: "workspace", label: "Workspace" }], title: "Session" }))),
      section("CommentThread", () => h(CommentThread, { thread, user: ana, onResolve: () => record("thread:resolve") })),
      section("CommentPanel", () => h(CommentPanel, { client: commentsClient, subject: pricing })),
      // The list floats over the page. A transform keeps it inside its section.
      section("CommentList", () => h("div", { style: "height: 360px; overflow: hidden; position: relative; transform: translateZ(0)" }, h(Comments))),
      section("Chat", () => h("div", { style: "height: 320px; display: flex; flex-direction: column" }, h(Chat, { messages }))),
      section("ConnectPanel", () => h(ConnectPanel, { connect })),
      section("WorkspaceShell", () => h("div", { style: "height: 320px" }, h(WorkspaceShell, {
        layout: "tutorial",
        storageKey: false,
        tabs: [{ label: "Console", value: "terminal" }, { badge: 2, label: "Messages", value: "messages" }],
      }, { editor: () => h("p", "editor"), messages: () => h("p", "messages panel"), terminal: () => h("p", "terminal panel") }))),
      section("WorkspacePreview", () => h("div", { style: "height: 240px" }, h(WorkspacePreview, { url: "about:blank" }))),
      section("PlaygroundContainer", () => h("div", { style: "height: 480px" }, h(PlaygroundContainer, { name: "demo", templates: [template("kv", "KV"), template("blob", "Blob")] }))),
    ]);
  },
});
