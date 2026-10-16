import { defineComponent, h, type PropType } from "vue";
import { slotPart } from "../internal/slot-part.ts";

export type MessageAlign = "start" | "end";

export const MessageGroup = slotPart("MessageGroup", "message-group");

export const Message = defineComponent({
  name: "Message",
  props: {
    align: { default: "start", type: String as PropType<MessageAlign> },
  },
  setup(props, { attrs, slots }) {
    return () => h("div", { ...attrs, "data-align": props.align, "data-slot": "message" }, slots.default?.());
  },
});

export const MessageAvatar = slotPart("MessageAvatar", "message-avatar");
export const MessageContent = slotPart("MessageContent", "message-content");
export const MessageHeader = slotPart("MessageHeader", "message-header");
export const MessageFooter = slotPart("MessageFooter", "message-footer");
