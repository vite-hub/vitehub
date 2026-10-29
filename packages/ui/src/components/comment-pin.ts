import type { CommentStatus, CommentUser } from "@vite-hub/comments/client";
import { defineComponent, h, type PropType } from "vue";
import { displayName, toPerson } from "../internal/comment-person.ts";
import { AvatarStack } from "./avatar-stack.ts";

// The Figma pin: the author's avatar in a circle whose bottom-left corner is the spot, with the thread number on it.
// A draft has no number yet, because the server assigns it.
export const CommentPin = defineComponent({
  name: "CommentPin",
  props: {
    /** The thread number. A draft has none. */
    n: { type: Number },
    author: { type: Object as PropType<CommentUser> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    status: { default: "open", type: String as PropType<CommentStatus> },
    /** A short piece of the comment. It is part of the label that a screen reader says. */
    excerpt: { type: String },
    /** The thread of this pin is open. */
    active: { default: false, type: Boolean },
    /** The comment is still being written. */
    draft: { default: false, type: Boolean },
  },
  emits: ["select", "hover", "leave"],
  setup(props, { emit }) {
    const label = () => {
      if (props.draft) return "New comment";
      const by = props.author ? ` by ${displayName(props.author)}` : "";
      const text = props.excerpt ? `: ${props.excerpt}` : "";
      return `Comment ${props.n}${by}${text}${props.status === "resolved" ? ", resolved" : ""}`;
    };
    return () =>
      h(
        "button",
        {
          "aria-expanded": props.draft ? undefined : String(props.active),
          "aria-label": label(),
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
          props.author ? h(AvatarStack, { "aria-hidden": "true", people: [toPerson(props.author)], size: "sm" }) : null,
          props.draft || props.n === undefined ? null : h("span", { "data-slot": "comment-pin-number" }, String(props.n)),
        ],
      );
  },
});
