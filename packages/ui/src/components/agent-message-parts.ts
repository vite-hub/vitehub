import type { UIMessage } from "ai";
import { defineComponent, h, type PropType, resolveComponent, type VNodeChild } from "vue";
import { isSafeExternalUrl } from "../internal/url.ts";
import { AgentMarkdown } from "./agent-markdown.ts";

type Part = UIMessage["parts"][number];
type ToolLikePart = Extract<Part, { state: string; toolCallId: string }>;

function titleForTool(part: ToolLikePart): string {
  if (part.type === "dynamic-tool") return part.title ?? part.toolName;
  return part.type.slice("tool-".length).replaceAll(/[-_]/g, " ");
}

function toolValue(part: ToolLikePart): unknown {
  if ("output" in part && part.output !== undefined) return part.output;
  if ("errorText" in part && part.errorText) return part.errorText;
  return "input" in part ? part.input : undefined;
}

function isToolPart(part: Part): part is ToolLikePart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function isSafeFileUrl(value: string, filename: string | undefined): boolean {
  if (isSafeExternalUrl(value)) return true;
  return Boolean(filename) && /^data:[^,]*,/i.test(value);
}

function filePart(part: Extract<Part, { type: "file" }>): VNodeChild {
  const label = part.filename ?? part.mediaType;
  if (!isSafeFileUrl(part.url, part.filename)) {
    return h("span", { class: "vh-attachment" }, [
      h("span", { class: "vh-attachment__name" }, label),
    ]);
  }
  const image = part.mediaType === "image" || part.mediaType.startsWith("image/");
  return h(
    "a",
    {
      class: "vh-attachment",
      download: part.filename,
      href: part.url,
      rel: isSafeExternalUrl(part.url) ? "noreferrer" : undefined,
      target: isSafeExternalUrl(part.url) ? "_blank" : undefined,
    },
    [
      image
        ? h("img", {
            alt: "",
            class: "vh-attachment__preview",
            src: part.url,
          })
        : null,
      h("span", { class: "vh-attachment__name" }, label),
    ],
  );
}

export const AgentMessageParts = defineComponent({
  name: "AgentMessageParts",
  props: {
    parts: { required: true, type: Array as PropType<UIMessage["parts"]> },
    streaming: { default: false, type: Boolean },
  },
  setup(props, { slots }) {
    return () =>
      h(
        "div",
        { class: "vh-message-parts", "data-slot": "message-parts" },
        props.parts.map((part, index) => {
          const custom = slots.part?.({ index, part });
          if (custom?.length) return custom;
          if (part.type === "text") {
            return (
              slots.text?.({ index, part }) ??
              h(AgentMarkdown, {
                key: index,
                streaming: props.streaming || part.state === "streaming",
                value: part.text,
              })
            );
          }
          if (part.type === "reasoning") {
            const UChatReasoning = resolveComponent("UChatReasoning");
            return (
              slots.reasoning?.({ index, part }) ??
              h(UChatReasoning, {
                key: index,
                streaming: props.streaming || part.state === "streaming",
                text: part.text,
              })
            );
          }
          if (isToolPart(part)) {
            const UChatTool = resolveComponent("UChatTool");
            const loading = part.state === "input-streaming" || part.state === "input-available";
            return (
              slots.tool?.({ index, part }) ??
              h(
                UChatTool,
                {
                  key: part.toolCallId,
                  loading,
                  text: titleForTool(part),
                  variant: "outline",
                },
                {
                  default: () =>
                    h("pre", { class: "vh-tool-value" }, JSON.stringify(toolValue(part), null, 2)),
                },
              )
            );
          }
          if (part.type === "file") return slots.file?.({ index, part }) ?? filePart(part);
          if (part.type === "source-url") {
            const label = part.title ?? part.url;
            return (
              slots.source?.({ index, part }) ??
              (isSafeExternalUrl(part.url)
                ? h(
                    "a",
                    {
                      class: "vh-source",
                      href: part.url,
                      rel: "noreferrer",
                      target: "_blank",
                    },
                    label,
                  )
                : h("span", { class: "vh-source" }, label))
            );
          }
          if (part.type === "source-document") {
            return slots.source?.({ index, part }) ?? h("span", { class: "vh-source" }, part.title);
          }
          if (part.type === "step-start") return slots.step?.({ index, part }) ?? null;
          return slots.fallback?.({ index, part }) ?? null;
        }),
      );
  },
});
