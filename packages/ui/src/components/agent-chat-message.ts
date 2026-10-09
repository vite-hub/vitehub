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
      // The same defaults as Nuxt UI's `UChatMessages`: the user speaks from the right in a bubble, the assistant replies as plain text.
      const user = props.message.role === "user";
      return h(
        UChatMessage,
        {
          side: user ? "right" : "left",
          variant: user ? "soft" : "naked",
          ...attrs,
          "aria-label": attrs["aria-label"] ?? `${user ? "User" : props.message.role === "assistant" ? "Assistant" : "System"} message`,
          id: props.message.id,
          metadata: props.message.metadata,
          parts: props.message.parts,
          role: props.message.role,
          ui: props.ui,
        },
        {
          // The parts render inside Nuxt UI's content slot, so the variant keeps its bubble and the actions keep their row.
          // The default slot replaces the whole body instead.
          ...(slots.default
            ? { body: () => slots.default?.({ message: props.message }) }
            : {
                content: () =>
                  h(
                    AgentMessageParts,
                    {
                      parts: props.message.parts,
                      streaming: props.streaming,
                    },
                    slots,
                  ),
              }),
          header: slots.header ? () => slots.header?.({ message: props.message }) : undefined,
          leading: slots.leading ? () => slots.leading?.({ message: props.message }) : undefined,
          actions: slots.actions ? () => slots.actions?.({ message: props.message }) : undefined,
        },
      );
    };
  },
});
