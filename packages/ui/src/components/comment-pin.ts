import type { CommentStatus, CommentUser } from "@vite-hub/comments/client";
import { defineComponent, h, type PropType } from "vue";
import { AvatarStack } from "./avatar-stack.ts";

// The Figma pin: the author's avatar in a circle whose bottom-left corner is the spot, with the thread number on it.
export const CommentPin = defineComponent({
  name: "CommentPin",
  props: {
    /** The thread number. */
    n: { required: true, type: Number },
    author: { type: Object as PropType<CommentUser> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    status: { default: "open", type: String as PropType<CommentStatus> },
    /** The thread of this pin is open. */
    active: { default: false, type: Boolean },
    /** The comment is still being written. */
    draft: { default: false, type: Boolean },
  },
  emits: ["select", "hover", "leave"],
  setup(props, { emit }) {
    return () =>
      h(
        "button",
        {
          "aria-expanded": props.draft ? undefined : String(props.active),
          "aria-label": props.draft ? `New comment ${props.n}` : `Comment ${props.n}${props.status === "resolved" ? ", resolved" : ""}`,
          "data-active": props.active ? "true" : undefined,
          "data-draft": props.draft ? "true" : undefined,
          "data-slot": "comment-pin",
          "data-status": props.status,
          onBlur: () => emit("leave"),
          onClick: () => emit("select"),
          onFocus: () => emit("hover"),
          onPointerenter: () => emit("hover"),
          onPointerleave: () => emit("leave"),
          type: "button",
        },
        [
          props.author
            ? h(AvatarStack, { "aria-hidden": "true", people: [props.author], size: "sm" })
            : null,
          h("span", { "data-slot": "comment-pin-number" }, String(props.n)),
        ],
      );
  },
});
