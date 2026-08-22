import type { ChatStatus, UIMessage } from "ai";
import { defineComponent, h, type PropType } from "vue";
import type { ViteHubUISession } from "../types.ts";
import { AgentChat } from "./agent-chat.ts";

export const AgentSession = defineComponent({
  name: "AgentSession",
  inheritAttrs: false,
  props: {
    session: { required: true, type: Object as PropType<ViteHubUISession<UIMessage>> },
    status: { default: "ready", type: String as PropType<ChatStatus> },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "section",
        { ...attrs, class: ["vh-session", attrs.class], "data-session-id": props.session.id },
        [
          slots.header?.({ session: props.session }) ??
            (props.session.title
              ? h("header", { class: "vh-session__header" }, [
                  h("h2", { class: "vh-session__title" }, props.session.title),
                ])
              : null),
          h(
            AgentChat,
            { class: "vh-session__chat", messages: props.session.messages, status: props.status },
            slots,
          ),
          slots.footer?.({ session: props.session }),
        ],
      );
  },
});
