import type { UIMessage } from "ai";
import { defineComponent, h, type PropType, resolveComponent, type VNodeChild } from "vue";
import { isSafeExternalUrl } from "../internal/url.ts";
import { ImagePreview } from "../internal/image-preview.ts";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "./attachment.ts";
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "./code-block.ts";
import { Markdown } from "./markdown.ts";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceLineStatus,
} from "./trace.ts";

type Part = UIMessage["parts"][number];
type ToolLikePart = Extract<Part, { state: string; toolCallId: string }>;
type TracePart = ToolLikePart | Extract<Part, { type: "reasoning" | "source-url" | "source-document" }>;

function titleForTool(part: ToolLikePart): string {
  if (part.type === "dynamic-tool") return part.title ?? part.toolName;
  return part.type.slice("tool-".length).replaceAll(/[-_]/g, " ");
}

function isToolPart(part: Part): part is ToolLikePart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function isTracePart(part: Part): part is TracePart {
  return isToolPart(part) || part.type === "reasoning" || part.type === "source-url" || part.type === "source-document";
}

// Tool values come from the model and from tools, so they can be cyclic or throw on access.
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[Value cannot be shown]";
  }
}

function isSafeFileUrl(value: string, filename: string | undefined): boolean {
  if (isSafeExternalUrl(value)) return true;
  return Boolean(filename) && /^data:[^,]*,/i.test(value);
}

function icon(name: string) {
  const UIcon = resolveComponent("UIcon");
  return h(TraceIcon, () => h(UIcon, { name }));
}

function filePart(part: Extract<Part, { type: "file" }>): VNodeChild {
  const label = part.filename ?? part.mediaType;
  if (part.mediaType === "image" || part.mediaType.startsWith("image/")) return h(ImagePreview, { alt: label, src: part.url });
  const UIcon = resolveComponent("UIcon");
  const link = isSafeFileUrl(part.url, part.filename);
  return h(Attachment, { size: "sm" }, () => [
    link
      ? h(AttachmentTrigger, {
          "aria-label": `Open ${label}`,
          as: "a",
          download: part.filename,
          href: part.url,
          rel: isSafeExternalUrl(part.url) ? "noreferrer" : undefined,
          target: isSafeExternalUrl(part.url) ? "_blank" : undefined,
        })
      : null,
    h(AttachmentMedia, () => h(UIcon, { name: "i-ph-file-light" })),
    h(AttachmentContent, () => [
      h(AttachmentTitle, () => label),
      part.filename ? h(AttachmentDescription, () => part.mediaType) : null,
    ]),
  ]);
}

function codeBlock(title: string, value: unknown, destructive = false) {
  return h(CodeBlock, { size: "sm", variant: destructive ? "destructive" : "default" }, () => [
    h(CodeBlockHeader, () => h(CodeBlockTitle, () => title)),
    h(CodeBlockContent, { wrap: true }, () => valueText(value)),
  ]);
}

function toolStatus(part: ToolLikePart): TraceLineStatus | undefined {
  if (part.state === "output-error" || part.state === "output-denied") return "error";
  if (part.state === "input-streaming" || part.state === "input-available" || part.state === "approval-requested") return "running";
  return undefined;
}

function toolTrace(part: ToolLikePart) {
  const status = toolStatus(part);
  // Tool titles are often phrases already, such as "Run focused tests", so the state goes beside the title, not into it.
  const state = status === "error" ? "Failed" : status === "running" ? "Running" : undefined;
  const details = [
    "input" in part && part.input !== undefined ? codeBlock("Input", part.input) : null,
    "output" in part && part.output !== undefined ? codeBlock("Output", part.output) : null,
    "errorText" in part && part.errorText ? codeBlock("Error", part.errorText, true) : null,
  ].filter(Boolean);
  const line = h(TraceLine, { status }, () => [
    icon("i-ph-wrench-light"),
    h(TraceTitle, () => titleForTool(part)),
    state ? h(TraceDescription, () => state) : null,
  ]);
  if (details.length === 0) return h("div", { key: part.toolCallId }, line);
  return h(TraceCollapsible, { key: part.toolCallId }, () => [
    h(TraceCollapsibleTrigger, () => line),
    h(TraceCollapsibleContent, () => h("div", { class: "vh-message-parts__tool" }, details)),
  ]);
}

function reasoningTrace(part: Extract<Part, { type: "reasoning" }>, streaming: boolean, key: number) {
  return h(TraceCollapsible, { key }, () => [
    h(TraceCollapsibleTrigger, () =>
      h(TraceLine, { status: streaming ? "running" : undefined }, () => [
        icon("i-ph-brain-light"),
        h(TraceTitle, () => (streaming ? "Thinking" : "Thought")),
      ]),
    ),
    h(TraceCollapsibleContent, () => h(Markdown, { streaming, value: part.text })),
  ]);
}

function sourceTrace(part: Extract<Part, { type: "source-url" | "source-document" }>, key: number) {
  const label = part.title ?? (part.type === "source-url" ? part.url : "Source");
  const line = h(TraceLine, () => [icon("i-ph-link-simple-light"), h(TraceTitle, () => label)]);
  if (part.type === "source-url" && isSafeExternalUrl(part.url))
    return h("a", { href: part.url, key, rel: "noreferrer", target: "_blank" }, line);
  return h("div", { key }, line);
}

export const MessageParts = defineComponent({
  name: "MessageParts",
  props: {
    parts: { required: true, type: Array as PropType<UIMessage["parts"]> },
    streaming: { default: false, type: Boolean },
  },
  setup(props, { slots }) {
    function renderTracePart(part: TracePart, index: number): VNodeChild {
      if (part.type === "reasoning")
        return slots.reasoning?.({ index, part }) ?? reasoningTrace(part, props.streaming || part.state === "streaming", index);
      if (part.type === "source-url" || part.type === "source-document")
        return slots.source?.({ index, part }) ?? sourceTrace(part, index);
      return slots.tool?.({ index, part }) ?? toolTrace(part);
    }

    return () => {
      const children: VNodeChild[] = [];
      // Consecutive reasoning, tool, and source parts share one Trace, so the steps of a turn read as one list.
      let trace: VNodeChild[] | undefined;
      props.parts.forEach((part, index) => {
        const custom = slots.part?.({ index, part });
        if (custom?.length) {
          trace = undefined;
          children.push(custom);
          return;
        }
        if (isTracePart(part)) {
          if (!trace) {
            trace = [];
            const lines = trace;
            children.push(h(Trace, { key: `trace-${index}` }, () => lines));
          }
          trace.push(renderTracePart(part, index));
          return;
        }
        trace = undefined;
        if (part.type === "text") {
          children.push(
            slots.text?.({ index, part })
              ?? h(Markdown, { key: index, streaming: props.streaming || part.state === "streaming", value: part.text }),
          );
        } else if (part.type === "file") {
          children.push(slots.file?.({ index, part }) ?? filePart(part));
        } else if (part.type === "step-start") {
          children.push(slots.step?.({ index, part }) ?? null);
        } else {
          children.push(slots.fallback?.({ index, part }) ?? null);
        }
      });
      return h("div", { class: "vh-message-parts", "data-slot": "message-parts" }, children);
    };
  },
});
