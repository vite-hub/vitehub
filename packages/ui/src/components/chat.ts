import type { ChatStatus, UIMessage } from "ai";
import { defineComponent, h, type PropType } from "vue";
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScroller,
  MessageScrollerViewport,
} from "../headless/message-scroller.ts";
import { useViteHubUI } from "../config.ts";
import { ChatMessage } from "./chat-message.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

type Part = UIMessage["parts"][number];

const inProgressTool = new Set(["approval-requested", "approval-responded", "input-available", "input-streaming"]);

// Streaming text, a running tool, and live reasoning draw their own progress in the message.
function showsProgress(part: Part): boolean {
  if (part.type === "text" || part.type === "reasoning") return part.state !== "done";
  return "toolCallId" in part && inProgressTool.has(part.state);
}

/**
 * The line Chat shows while a reply is on its way and nothing in the message moves: before the first part, after a
 * message ends, and after a tool finishes. Returns undefined when the chat is not busy or the message shows progress.
 */
export function chatActivity(messages: readonly UIMessage[], status: ChatStatus): string | undefined {
  if (status !== "submitted" && status !== "streaming") return undefined;
  const last = messages.at(-1);
  // Data parts carry events for code, not for the reader, and a step start draws nothing.
  const part = last?.role === "assistant"
    ? last.parts.findLast(part => !part.type.startsWith("data-") && part.type !== "step-start")
    : undefined;
  return part && showsProgress(part) ? undefined : "Working";
}

export const Chat = defineComponent({
  name: "Chat",
  inheritAttrs: false,
  props: {
    edgeThreshold: { type: Number },
    messages: { default: () => [], type: Array as PropType<readonly UIMessage[]> },
    previousItemPeek: { type: Number },
    scrollButtonLabel: { default: "Scroll to end", type: String },
    status: { default: "ready", type: String as PropType<ChatStatus> },
  },
  setup(props, { attrs, slots }) {
    const defaults = useViteHubUI();
    const UButton = useUIComponent("UButton");
    // A static dot and a text that changes: progress without a looping animation.
    const activity = () => {
      const label = chatActivity(props.messages, props.status);
      if (!label) return null;
      return slots.status?.({ label }) ?? h("p", { class: "vh-chat__status", "data-slot": "chat-status", role: "status" }, [
        h("span", { "aria-hidden": "true", class: "vh-chat__status-dot" }),
        h("span", { class: "vh-chat__status-label" }, label),
      ]);
    };
    return () => {
      const composer = slots.composer?.();
      const messageSlots = Object.fromEntries(
        Object.entries(slots).filter(
          ([name]) =>
            name !== "composer" && name !== "default" && name !== "message" && name !== "scroll-button" && name !== "status",
        ),
      );
      return h(
        MessageScroller,
        {
          ...attrs,
          class: ["vh-chat", attrs.class],
          edgeThreshold: props.edgeThreshold ?? defaults.messageScroller.edgeThreshold,
          previousItemPeek: props.previousItemPeek ?? defaults.messageScroller.previousItemPeek,
        },
        {
          default: () => [
            h(
              MessageScrollerViewport,
              { class: "vh-chat__viewport" },
              {
                default: () =>
                  h(
                    MessageScrollerContent,
                    {
                      "aria-busy": props.status === "streaming" || props.status === "submitted" ? "true" : undefined,
                      class: "vh-chat__content",
                      items: props.messages.map((message) => message.id),
                    },
                    {
                      default: () => [
                        ...props.messages.map((message, index) =>
                          h(
                            MessageScrollerItem,
                            {
                              key: message.id,
                              messageId: message.id,
                              scrollAnchor:
                                message.role === "user" && index === props.messages.length - 1 && props.status !== "submitted",
                            },
                            {
                              default: () =>
                                slots.message?.({ index, message }) ??
                                h(
                                  ChatMessage,
                                  {
                                    message,
                                    streaming:
                                      index === props.messages.length - 1 &&
                                      (props.status === "streaming" ||
                                        props.status === "submitted"),
                                  },
                                  messageSlots,
                                ),
                            },
                          ),
                        ),
                        activity(),
                      ],
                    },
                  ),
              },
            ),
            h(
              MessageScrollerButton,
              {
                "aria-label": props.scrollButtonLabel,
                as: UButton,
                class: "vh-chat__scroll-button",
                color: "neutral",
                icon: "i-lucide-chevron-down",
                size: "xs",
                type: "button",
                ui: { leadingIcon: "size-3.5" },
                variant: "outline",
              },
              { default: () => slots["scroll-button"]?.() ?? props.scrollButtonLabel },
            ),
            composer?.length
              ? h("div", { class: "vh-chat__composer", "data-slot": "chat-composer" }, composer)
              : null,
            slots.default?.(),
          ],
        },
      );
    };
  },
});
