import type { ChatStatus, UIMessage } from "ai";
import { defineComponent, h, type PropType, resolveComponent } from "vue";
import {
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerRoot,
  MessageScrollerViewport,
} from "../headless/message-scroller.ts";
import { useViteHubUI } from "../config.ts";
import { AgentChatMessage } from "./agent-chat-message.ts";

export const AgentChat = defineComponent({
  name: "AgentChat",
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
    const UButton = resolveComponent("UButton");
    return () => {
      const composer = slots.composer?.();
      const messageSlots = Object.fromEntries(
        Object.entries(slots).filter(
          ([name]) =>
            name !== "composer" && name !== "default" && name !== "message" && name !== "scroll-button",
        ),
      );
      return h(
        MessageScrollerRoot,
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
                      default: () =>
                        props.messages.map((message, index) =>
                          h(
                            MessageScrollerItem,
                            {
                              key: message.id,
                              messageId: message.id,
                              scrollAnchor:
                                message.role === "user" && index === props.messages.length - 1,
                            },
                            {
                              default: () =>
                                slots.message?.({ index, message }) ??
                                h(
                                  AgentChatMessage,
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
