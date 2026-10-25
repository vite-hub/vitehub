import type { CommentMessage, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { defineComponent, h, nextTick, type PropType, ref, resolveComponent } from "vue";
import {
  consumedPointerEvents,
  shakeDirtyComposers,
  swallowNextClick,
  useDocumentPointerDown,
} from "../internal/comment-outside.ts";
import { timeAgo } from "../internal/comment-time.ts";
import { AvatarStack } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSubmit } from "./comment-composer.ts";
import { Markdown } from "./markdown.ts";
import { Marker, MarkerContent } from "./marker.ts";

// One message of a thread. The first message is the comment, and the rest are replies.
// Its author edits and deletes it. Editing opens a composer in place.
export const CommentReply = defineComponent({
  name: "CommentReply",
  props: {
    message: { required: true, type: Object as PropType<CommentMessage> },
    /** The signed-in user may edit and delete this message. */
    editable: { default: false, type: Boolean },
    /** The message, and its author, show in one line without actions. */
    compact: { default: false, type: Boolean },
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
  },
  emits: ["edit", "delete"],
  setup(props, { emit }) {
    const UButton = resolveComponent("UButton");
    const editing = ref(false);
    const draft = ref("");
    const mentions = ref<string[]>([]);

    function startEdit() {
      draft.value = props.message.body;
      mentions.value = [...props.message.mentions];
      editing.value = true;
    }
    function save(submit: CommentComposerSubmit) {
      emit("edit", props.message.id, submit.body, submit.mentions);
      editing.value = false;
    }

    return () => {
      const { message } = props;
      return h(
        "div",
        { "data-compact": props.compact ? "true" : undefined, "data-editing": editing.value ? "true" : undefined, "data-slot": "comment-reply" },
        [
          h(AvatarStack, { "aria-hidden": "true", people: [message.author], size: "sm" }),
          h("div", { "data-slot": "comment-reply-content" }, [
            h("div", { "data-slot": "comment-reply-header" }, [
              h("span", { "data-slot": "comment-reply-author" }, message.author.name),
              message.actor ? h("span", { "data-slot": "comment-reply-actor" }, `via ${message.actor.name ?? message.actor.id}`) : null,
              h(
                "time",
                { "data-slot": "comment-reply-time", datetime: new Date(message.createdAt).toISOString(), title: new Date(message.createdAt).toLocaleString() },
                timeAgo(message.createdAt),
              ),
              message.editedAt ? h("span", { "data-slot": "comment-reply-edited" }, "edited") : null,
            ]),
            editing.value
              ? h(CommentComposer, {
                  autofocus: true,
                  mentions: mentions.value,
                  modelValue: draft.value,
                  onCancel: () => (editing.value = false),
                  onSubmit: save,
                  "onUpdate:mentions": (value: string[]) => (mentions.value = value),
                  "onUpdate:modelValue": (value: string) => (draft.value = value),
                  users: props.users,
                  variant: "edit",
                })
              : h(Markdown, { "data-slot": "comment-reply-body", value: message.body }),
          ]),
          props.editable && !editing.value && !props.compact
            ? h("div", { "data-slot": "comment-reply-actions" }, [
                h(UButton, { "aria-label": "Edit", color: "neutral", icon: "i-ph-pencil-simple-light", onClick: startEdit, size: "xs", variant: "ghost" }),
                h(UButton, {
                  "aria-label": "Delete",
                  color: "neutral",
                  icon: "i-ph-trash-light",
                  onClick: () => emit("delete", message.id),
                  size: "xs",
                  variant: "ghost",
                }),
              ])
            : null,
        ],
      );
    };
  },
});

// The thread of one pin: the comment and its replies, a reply box, Resolve or Reopen, and Close.
// With `preview` it is the hover card of a pin: the comment, the reply count, and no controls.
export const CommentThread = defineComponent({
  name: "CommentThread",
  props: {
    thread: { required: true, type: Object as PropType<CommentThreadModel> },
    /** The signed-in user. Their messages can be edited and deleted. */
    user: { type: Object as PropType<CommentUser> },
    /** A read-only card for hovering a pin. */
    preview: { default: false, type: Boolean },
    /** A reply is being sent. */
    busy: { default: false, type: Boolean },
    /** Why the last action failed. */
    error: { type: String },
    /** The thread is no longer on the page, so no pin shows where it was. */
    detached: { default: false, type: Boolean },
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
  },
  emits: ["reply", "edit", "delete", "resolve", "reopen", "close"],
  setup(props, { emit }) {
    const UButton = resolveComponent("UButton");
    const root = ref<HTMLElement | null>(null);
    const reply = ref("");
    const mentions = ref<string[]>([]);
    const composer = ref<{ focus: () => void } | null>(null);

    // A click outside closes the thread, unless a reply is half written: then the reply box shakes.
    useDocumentPointerDown((event) => {
      const target = event.target;
      if (props.preview || !(target instanceof Element) || root.value?.contains(target)) return;
      if (target.closest("[data-slot='comment-pin']") || consumedPointerEvents.has(event)) return;
      consumedPointerEvents.add(event);
      if (shakeDirtyComposers()) {
        event.stopPropagation();
        swallowNextClick();
      } else emit("close");
    });

    function send(submit: CommentComposerSubmit) {
      emit("reply", submit.body, submit.mentions);
      reply.value = "";
      mentions.value = [];
      void nextTick(() => composer.value?.focus());
    }

    return () => {
      const { thread } = props;
      const resolved = thread.status === "resolved";
      const first = thread.messages[0];
      const quote = thread.anchor.kind === "text" ? thread.anchor.exact : undefined;
      if (props.preview) {
        const replies = thread.messages.length - 1;
        return h("div", { "data-slot": "comment-thread", "data-preview": "true", "data-status": thread.status }, [
          first ? h(CommentReply, { compact: true, message: first }) : null,
          replies > 0 ? h("p", { "data-slot": "comment-thread-count" }, `${replies} ${replies === 1 ? "reply" : "replies"}`) : null,
        ]);
      }
      return h(
        "section",
        { "aria-label": `Comment ${thread.n}`, "data-slot": "comment-thread", "data-status": thread.status, ref: root, role: "dialog" },
        [
          h("header", { "data-slot": "comment-thread-header" }, [
            h("span", { "data-slot": "comment-thread-title" }, `Comment ${thread.n}`),
            h("span", { "data-slot": "comment-thread-spacer" }),
            h(UButton, {
              "aria-label": resolved ? "Reopen" : "Resolve",
              color: "neutral",
              icon: resolved ? "i-ph-arrow-counter-clockwise" : "i-ph-check",
              onClick: () => emit(resolved ? "reopen" : "resolve"),
              size: "xs",
              variant: "ghost",
            }),
            h(UButton, { "aria-label": "Close", color: "neutral", icon: "i-ph-x-light", onClick: () => emit("close"), size: "xs", variant: "ghost" }),
          ]),
          h("div", { "data-slot": "comment-thread-messages" }, [
            quote ? h("blockquote", { "data-slot": "comment-thread-quote" }, quote) : null,
            props.detached
              ? h("p", { "data-slot": "comment-thread-detached", role: "status" }, "The place of this comment is no longer on the page.")
              : null,
            ...thread.messages.map(message =>
              h(CommentReply, {
                editable: message.author.id === props.user?.id,
                key: message.id,
                message,
                onDelete: (messageId: string) => emit("delete", messageId),
                onEdit: (messageId: string, body: string, ids: string[]) => emit("edit", messageId, body, ids),
                users: props.users,
              }),
            ),
            resolved
              ? h(Marker, { variant: "separator" }, () =>
                  h(MarkerContent, () => `Resolved${thread.resolvedBy ? ` by ${thread.resolvedBy.name}` : ""}`),
                )
              : null,
          ]),
          h(CommentComposer, {
            autofocus: false,
            busy: props.busy,
            error: props.error,
            guard: false,
            mentions: mentions.value,
            modelValue: reply.value,
            onSubmit: send,
            "onUpdate:mentions": (value: string[]) => (mentions.value = value),
            "onUpdate:modelValue": (value: string) => (reply.value = value),
            ref: composer,
            user: props.user,
            users: props.users,
            variant: "reply",
          }),
        ],
      );
    };
  },
});
