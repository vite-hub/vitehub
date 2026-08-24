import type { ChatStatus, UIMessage } from "ai";
import { defineComponent, h, type PropType } from "vue";
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
    status: { default: "ready", type: String as PropType<ChatStatus> },
  },
  setup(props, { attrs, slots }) {
    const defaults = useViteHubUI();
    return () => {
      const messageSlots = Object.fromEntries(
        Object.entries(slots).filter(
          ([name]) => name !== "default" && name !== "message" && name !== "scroll-button",
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
              { class: "vh-chat__scroll-button" },
              { default: () => slots["scroll-button"]?.() ?? "↓" },
            ),
            slots.default?.(),
          ],
        },
      );
    };
  },
});
