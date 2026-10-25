import type { CommentMessage, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, type PropType, ref, resolveComponent } from "vue";
import {
  consumedPointerEvents,
  pathOf,
  shakeDirtyComposers,
  swallowNextClick,
  useDocumentPointerDown,
} from "../internal/comment-outside.ts";
import { displayName, toPerson } from "../internal/comment-person.ts";
import { timeAgo } from "../internal/comment-time.ts";
import { AvatarStack } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSubmit } from "./comment-composer.ts";
import { Markdown } from "./markdown.ts";
import { Marker, MarkerContent } from "./marker.ts";

type Done = Promise<unknown> | void;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "That did not work. Try again.";
}

// One message of a thread. The first message is the comment, and the rest are replies.
// Its author edits and deletes it. Editing opens a composer in place, and it closes when the edit has been saved.
// The handlers may return a promise: the part waits for it, and on a failure it keeps the text and shows the error.
export const CommentReply = defineComponent({
  name: "CommentReply",
  props: {
    message: { required: true, type: Object as PropType<CommentMessage> },
    /** The signed-in user may edit and delete this message. */
    editable: { default: false, type: Boolean },
    /** The message, and its author, show in one line without actions. */
    compact: { default: false, type: Boolean },
    /** Deleting asks first. Deleting the first message of a thread deletes the whole thread, so a thread sets it there. */
    confirmDelete: { default: false, type: Boolean },
    /** People whose `@name` the message may hold, so an edit keeps their mentions. */
    people: { default: () => [], type: Array as PropType<CommentUser[]> },
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
    /** Saves an edit. Gets `(messageId, body, mentions)`. */
    onEdit: { type: Function as PropType<(messageId: string, body: string, mentions: string[]) => Done> },
    /** Deletes the message. Gets `(messageId)`. */
    onDelete: { type: Function as PropType<(messageId: string) => Done> },
  },
  setup(props) {
    const UButton = resolveComponent("UButton");
    const editing = ref(false);
    const confirming = ref(false);
    const busy = ref(false);
    const error = ref<string | undefined>();
    const draft = ref("");
    const mentions = ref<string[]>([]);

    async function run(task: () => Done): Promise<boolean> {
      if (busy.value) return false;
      busy.value = true;
      error.value = undefined;
      try {
        await task();
        return true;
      } catch (cause) {
        error.value = reason(cause);
        return false;
      } finally {
        busy.value = false;
      }
    }
    function startEdit() {
      draft.value = props.message.body;
      mentions.value = [...props.message.mentions];
      error.value = undefined;
      editing.value = true;
    }
    async function save(submit: CommentComposerSubmit) {
      if (await run(() => props.onEdit?.(props.message.id, submit.body, submit.mentions))) editing.value = false;
    }
    async function remove() {
      if (await run(() => props.onDelete?.(props.message.id))) confirming.value = false;
    }

    return () => {
      const { message } = props;
      return h(
        "div",
        { "data-compact": props.compact ? "true" : undefined, "data-editing": editing.value ? "true" : undefined, "data-slot": "comment-reply" },
        [
          h(AvatarStack, { "aria-hidden": "true", people: [toPerson(message.author)], size: "sm" }),
          h("div", { "data-slot": "comment-reply-content" }, [
            h("div", { "data-slot": "comment-reply-header" }, [
              h("span", { "data-slot": "comment-reply-author" }, displayName(message.author)),
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
                  busy: busy.value,
                  error: error.value,
                  mentions: mentions.value,
                  modelValue: draft.value,
                  onCancel: () => {
                    if (!busy.value) editing.value = false;
                  },
                  onSubmit: save,
                  "onUpdate:mentions": (value: string[]) => (mentions.value = value),
                  "onUpdate:modelValue": (value: string) => (draft.value = value),
                  people: props.people,
                  users: props.users,
                  variant: "edit",
                })
              : h(Markdown, { "data-slot": "comment-reply-body", value: message.body }),
            confirming.value
              ? h("div", { "aria-label": "Confirm delete", "data-slot": "comment-reply-confirm", role: "group" }, [
                  h("p", "Delete this comment and every reply to it?"),
                  h(UButton, { color: "error", label: "Delete thread", loading: busy.value, onClick: remove, size: "xs" }),
                  h(UButton, { color: "neutral", label: "Cancel", onClick: () => (confirming.value = false), size: "xs", variant: "ghost" }),
                ])
              : null,
            !editing.value && error.value ? h("p", { "data-slot": "comment-reply-error", role: "alert" }, error.value) : null,
          ]),
          props.editable && !editing.value && !confirming.value && !props.compact
            ? h("div", { "data-slot": "comment-reply-actions" }, [
                h(UButton, { "aria-label": "Edit", color: "neutral", icon: "i-ph-pencil-simple-light", onClick: startEdit, size: "xs", variant: "ghost" }),
                h(UButton, {
                  "aria-label": "Delete",
                  color: "neutral",
                  icon: "i-ph-trash-light",
                  onClick: () => (props.confirmDelete ? (confirming.value = true) : void remove()),
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
// A reply clears its box only after `onReply` has succeeded. On a failure the text stays and the error shows.
export const CommentThread = defineComponent({
  name: "CommentThread",
  props: {
    thread: { required: true, type: Object as PropType<CommentThreadModel> },
    /** The signed-in user. Their messages can be edited and deleted. */
    user: { type: Object as PropType<CommentUser> },
    /** A read-only card for hovering a pin. */
    preview: { default: false, type: Boolean },
    /** Show a reply as being sent, on top of the thread's own tracking. */
    busy: { default: false, type: Boolean },
    /** An error to show, on top of the ones from the handlers. */
    error: { type: String },
    /** The thread is no longer on the page, so no pin shows where it was. */
    detached: { default: false, type: Boolean },
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
    /** Sends a reply. Gets `(body, mentions)`. */
    onReply: { type: Function as PropType<(body: string, mentions: string[]) => Done> },
    /** Saves an edited message. Gets `(messageId, body, mentions)`. */
    onEdit: { type: Function as PropType<(messageId: string, body: string, mentions: string[]) => Done> },
    /** Deletes a message. Gets `(messageId)`. Deleting the first message deletes the thread. */
    onDelete: { type: Function as PropType<(messageId: string) => Done> },
    onResolve: { type: Function as PropType<() => Done> },
    onReopen: { type: Function as PropType<() => Done> },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const UButton = resolveComponent("UButton");
    const root = ref<HTMLElement | null>(null);
    const reply = ref("");
    const mentions = ref<string[]>([]);
    const sending = ref(false);
    const failure = ref<string | undefined>();
    const composer = ref<{ focus: () => void } | null>(null);

    const people = computed(() => {
      const seen = new Map<string, CommentUser>();
      for (const person of [props.thread.author, ...props.thread.messages.map((message) => message.author), ...(props.user ? [props.user] : [])]) {
        seen.set(person.id, person);
      }
      return [...seen.values()];
    });

    // A click outside closes the thread, unless a reply is half written: then that box shakes.
    useDocumentPointerDown((event) => {
      const path = pathOf(event);
      if (props.preview || !root.value || path.includes(root.value)) return;
      if (path.some((element) => element.matches("[data-slot='comment-pin']")) || consumedPointerEvents.has(event)) return;
      consumedPointerEvents.add(event);
      const where = root.value.getRootNode();
      if (shakeDirtyComposers(where instanceof ShadowRoot ? where : document)) {
        event.stopPropagation();
        swallowNextClick();
      } else emit("close");
    });

    async function send(submit: CommentComposerSubmit) {
      if (sending.value) return;
      sending.value = true;
      failure.value = undefined;
      try {
        await props.onReply?.(submit.body, [...submit.mentions]);
        reply.value = "";
        mentions.value = [];
        void nextTick(() => composer.value?.focus());
      } catch (cause) {
        failure.value = reason(cause);
      } finally {
        sending.value = false;
      }
    }
    // Resolve and Reopen show their failure too.
    async function act(task: (() => Done) | undefined) {
      failure.value = undefined;
      try {
        await task?.();
      } catch (cause) {
        failure.value = reason(cause);
      }
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
        { "aria-label": `Comment ${thread.n}`, "data-slot": "comment-thread", "data-status": thread.status, ref: root, role: "dialog", tabindex: -1 },
        [
          h("header", { "data-slot": "comment-thread-header" }, [
            h("span", { "data-slot": "comment-thread-title" }, `Comment ${thread.n}`),
            h("span", { "data-slot": "comment-thread-spacer" }),
            h(UButton, {
              "aria-label": resolved ? "Reopen" : "Resolve",
              color: "neutral",
              icon: resolved ? "i-ph-arrow-counter-clockwise" : "i-ph-check",
              onClick: () => void act(resolved ? props.onReopen : props.onResolve),
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
            ...thread.messages.map((message, index) =>
              h(CommentReply, {
                confirmDelete: index === 0,
                editable: message.author.id === props.user?.id,
                key: message.id,
                message,
                onDelete: props.onDelete,
                onEdit: props.onEdit,
                people: people.value,
                users: props.users,
              }),
            ),
            resolved
              ? h(Marker, { variant: "separator" }, () =>
                  h(MarkerContent, () => `Resolved${thread.resolvedBy ? ` by ${displayName(thread.resolvedBy)}` : ""}`),
                )
              : null,
          ]),
          h(CommentComposer, {
            autofocus: false,
            busy: props.busy || sending.value,
            error: failure.value ?? props.error,
            guard: false,
            mentions: mentions.value,
            modelValue: reply.value,
            onSubmit: send,
            "onUpdate:mentions": (value: string[]) => (mentions.value = value),
            "onUpdate:modelValue": (value: string) => (reply.value = value),
            people: people.value,
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
