import type { UIMessage } from "ai";
import { defineComponent, h, type PropType, resolveComponent } from "vue";
import { AgentMessageParts } from "./agent-message-parts.ts";

export const AgentChatMessage = defineComponent({
  name: "AgentChatMessage",
  inheritAttrs: false,
  props: {
    message: { required: true, type: Object as PropType<UIMessage> },
    streaming: { default: false, type: Boolean },
    ui: { type: Object as PropType<Record<string, unknown>> },
  },
  setup(props, { attrs, slots }) {
    return () => {
      const UChatMessage = resolveComponent("UChatMessage");
      return h(
        UChatMessage,
        {
          ...attrs,
          "aria-label": attrs["aria-label"] ?? `${props.message.role === "user" ? "User" : props.message.role === "assistant" ? "Assistant" : "System"} message`,
          id: props.message.id,
          metadata: props.message.metadata,
          parts: props.message.parts,
          role: props.message.role,
          ui: props.ui,
        },
        {
          body: () =>
            slots.default?.({ message: props.message }) ??
            h(
              AgentMessageParts,
              {
                parts: props.message.parts,
                streaming: props.streaming,
              },
              slots,
            ),
          header: slots.header ? () => slots.header?.({ message: props.message }) : undefined,
          leading: slots.leading ? () => slots.leading?.({ message: props.message }) : undefined,
          actions: slots.actions ? () => slots.actions?.({ message: props.message }) : undefined,
        },
      );
    };
  },
});
