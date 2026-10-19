import type { UIMessage } from "ai";
import { defineComponent, h, type PropType } from "vue";
import { Bubble, BubbleContent } from "./bubble.ts";
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from "./message.ts";
import { MessageParts } from "./message-parts.ts";

const roleLabels: Record<UIMessage["role"], string> = { assistant: "Assistant", system: "System", user: "User" };

// One AI SDK message as a shadcn/ui Message: the user speaks from the end in a bubble, the assistant replies without a frame.
export const ChatMessage = defineComponent({
  name: "ChatMessage",
  inheritAttrs: false,
  props: {
    message: { required: true, type: Object as PropType<UIMessage> },
    streaming: { default: false, type: Boolean },
  },
  setup(props, { attrs, slots }) {
    return () => {
      const { message } = props;
      const user = message.role === "user";
      // The default slot replaces the body. Other slots go to MessageParts.
      const parts = () => h(MessageParts, { parts: message.parts, streaming: props.streaming }, slots);
      const body = slots.default?.({ message })
        ?? (user ? h(Bubble, { align: "end", variant: "secondary" }, () => h(BubbleContent, parts)) : parts());
      return h(
        Message,
        {
          ...attrs,
          align: user ? "end" : "start",
          "aria-label": attrs["aria-label"] ?? `${roleLabels[message.role] ?? "System"} message`,
          "data-role": message.role,
          id: message.id,
        },
        () => [
          slots.leading ? h(MessageAvatar, () => slots.leading?.({ message })) : null,
          h(MessageContent, () => [
            slots.header ? h(MessageHeader, () => slots.header?.({ message })) : null,
            body,
            slots.actions ? h(MessageFooter, () => slots.actions?.({ message })) : null,
          ]),
        ],
      );
    };
  },
});
