import type { ChatStatus, UIMessage } from "ai";
import { defineComponent, h, type PropType } from "vue";
import type { ViteHubUISession } from "../types.ts";
import { Chat } from "./chat.ts";

export const ChatSession = defineComponent({
  name: "ChatSession",
  inheritAttrs: false,
  props: {
    session: { required: true, type: Object as PropType<ViteHubUISession<UIMessage>> },
    status: { default: "ready", type: String as PropType<ChatStatus> },
  },
  setup(props, { attrs, slots }) {
    return () => {
      const chatSlots = Object.fromEntries(
        Object.entries(slots).filter(([name]) => name !== "header" && name !== "footer"),
      );
      return h(
        "section",
        {
          ...attrs,
          "aria-label": attrs["aria-label"] ?? props.session.title ?? "Agent session",
          class: ["vh-session", attrs.class],
          "data-session-id": props.session.id,
        },
        [
          slots.header?.({ session: props.session }) ??
            (props.session.title
              ? h("header", { class: "vh-session__header" }, [
                  h("h2", { class: "vh-session__title" }, props.session.title),
                ])
              : null),
          h(
            Chat,
            { class: "vh-session__chat", messages: props.session.messages, status: props.status },
            chatSlots,
          ),
          slots.footer?.({ session: props.session }),
        ],
      );
    };
  },
});
