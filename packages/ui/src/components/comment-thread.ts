import type { CommentMessage, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { type Component, computed, defineComponent, h, nextTick, type PropType, ref, type SlotsType, type VNode } from "vue";
import {
  consumedPointerEvents,
  pathOf,
  shakeDirtyComposers,
  swallowNextClick,
  useDocumentPointerDown,
} from "../internal/comment-outside.ts";
import { mentionPlugin, mentionTag } from "../internal/comment-mentions.ts";
import { displayName, toPerson } from "../internal/comment-person.ts";
import { timeAgo } from "../internal/comment-time.ts";
import { injectComments } from "../internal/comments-context.ts";
import { type CommentCan, type CommentThreadAction, defaultCommentCan } from "../headless/comments.ts";
import { ImagePreview } from "../internal/image-preview.ts";
import { Attachment, AttachmentContent, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "./attachment.ts";
import { AvatarStack } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSlots, type CommentComposerSubmit } from "./comment-composer.ts";
import { Markdown } from "./markdown.ts";
import { Marker, MarkerContent } from "./marker.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

type Done = Promise<unknown> | void;

/** An attachment as `attachmentUrl` describes it: its URL, and the file name and media type when the key does not say. */
export interface CommentAttachmentLink {
  url: string;
  name?: string;
  /** The media type, such as `image/png`. An `image/*` attachment shows as an image. */
  type?: string;
}

/**
 * Gives the URL of an attachment key, such as a Blob key, or the URL with its name and media type. `undefined` shows the
 * key as a file without a link. An image shows as a thumbnail that opens full size.
 */
export type CommentAttachmentUrl = (key: string) => string | CommentAttachmentLink | undefined;

/** The scope of the `body` and `attachments` slots of `CommentReply`. */
export interface CommentReplySlotScope {
  message: CommentMessage;
}

export type CommentReplySlots = {
  /** The text of the message. Replaces the Markdown body with its mention chips. */
  body?: (scope: CommentReplySlotScope) => VNode[];
  /** The attachments of the message. Replaces the default thumbnails. */
  attachments?: (scope: CommentReplySlotScope) => VNode[];
};

/** The scope of the `actions`, `anchor`, and `after` slots of `CommentThread`. */
export interface CommentThreadSlotScope {
  thread: CommentThreadModel;
}

export type CommentThreadSlots = CommentReplySlots & CommentComposerSlots & {
  /** More buttons in the header, before Resolve. */
  actions?: (scope: CommentThreadSlotScope) => VNode[];
  /** What the thread is about. Replaces the default quote of the selected text. */
  anchor?: (scope: CommentThreadSlotScope) => VNode[];
  /** Below the messages and above the reply box. */
  after?: (scope: CommentThreadSlotScope) => VNode[];
};

const imageExtensions = new Set(["apng", "avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp"]);

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "That did not work. Try again.";
}

const fileName = (key: string) => key.split(/[/\\]/).at(-1) || key;

// Shows the attachments of a message: images as thumbnails that open full size, and other files as chips. An attachment
// is an image when its media type says so, or, without one, when its name has an image extension or none.
function attachmentList(message: CommentMessage, url: CommentAttachmentUrl | undefined, icon: Component) {
  if (message.attachments.length === 0) return null;
  const items = message.attachments.map((key) => {
    const found = url?.(key);
    const link = typeof found === "string" ? { url: found } : found;
    const name = link?.name || fileName(key);
    const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
    const image = link !== undefined && (link.type ? link.type.startsWith("image/") : extension === undefined || imageExtensions.has(extension));
    return { href: link?.url, image, key, name };
  });
  const images = items.filter((item) => item.image);
  const files = items.filter((item) => !item.image);
  return [
    images.length > 0
      ? h("div", { "data-slot": "comment-reply-images" }, images.map((item) => h(ImagePreview, { alt: item.name, key: item.key, src: item.href })))
      : null,
    files.length > 0
      ? h(AttachmentGroup, { "data-slot": "comment-reply-attachments" }, () =>
          files.map((item) =>
            h(Attachment, { key: item.key, size: "xs" }, () => [
              h(AttachmentMedia, { variant: "icon" }, () => h(icon, { name: "i-ph-file-light" })),
              h(AttachmentContent, () =>
                h(AttachmentTitle, () => (item.href ? h("a", { href: item.href, rel: "noreferrer", target: "_blank" }, item.name) : item.name)),
              ),
            ]),
          ),
        )
      : null,
  ];
}

// One message of a thread. The first message is the comment, and the rest are replies.
// Its author edits and deletes it. Editing opens a composer in place, and it closes when the edit has been saved.
// The handlers may return a promise: the part waits for it, and on a failure it keeps the text and shows the error.
export const CommentReply = defineComponent({
  name: "CommentReply",
  props: {
    message: { required: true, type: Object as PropType<CommentMessage> },
    /** The signed-in user. A mention of them looks different. Defaults to the user of the comments state. */
    user: { type: Object as PropType<CommentUser> },
    /** The signed-in user may edit this message. */
    editable: { default: false, type: Boolean },
    /** The signed-in user may delete this message. Defaults to `editable`. */
    deletable: { default: undefined, type: Boolean },
    /** The message, and its author, show in one line without actions. */
    compact: { default: false, type: Boolean },
    /** Deleting asks first. Deleting the first message of a thread deletes the whole thread, so a thread sets it there. */
    confirmDelete: { default: false, type: Boolean },
    /** People whose `@name` the message may hold, so an edit keeps their mentions and the body marks them. */
    people: { default: () => [], type: Array as PropType<CommentUser[]> },
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
    /** Gives the URL of an attachment key. With it, image attachments show as thumbnails. */
    attachmentUrl: { type: Function as PropType<CommentAttachmentUrl> },
    /** Saves an edit. Gets `(messageId, body, mentions)`. */
    onEdit: { type: Function as PropType<(messageId: string, body: string, mentions: string[]) => Done> },
    /** Deletes the message. Gets `(messageId)`. */
    onDelete: { type: Function as PropType<(messageId: string) => Done> },
  },
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<CommentReplySlots & Pick<CommentComposerSlots, "mention-item">>,
  setup(props, { slots }) {
    const UButton = useUIComponent("UButton");
    const UIcon = useUIComponent("UIcon");
    const comments = injectComments();
    const editing = ref(false);
    const confirming = ref(false);
    const busy = ref(false);
    const error = ref<string | undefined>();
    const draft = ref("");
    const mentions = ref<string[]>([]);

    const self = () => props.user?.id ?? comments?.user.value?.id;
    // A mention chip. It marks only a person that the message really mentions, so typed component syntax stays text.
    const MentionChip = defineComponent({
      props: { label: { default: "", type: String }, user: { default: "", type: String } },
      setup(chip) {
        return () =>
          props.message.mentions.includes(chip.user)
            ? h("span", { "data-self": chip.user === self() ? "true" : undefined, "data-slot": "comment-mention" }, `@${chip.label}`)
            : `@${chip.label}`;
      },
    });
    const bodyComponents = { [mentionTag]: MentionChip };
    const bodyPlugins = computed(() => {
      const known = new Map<string, CommentUser>();
      for (const person of [...(comments?.people.value ?? []), ...props.people, ...(props.user ? [props.user] : [])]) known.set(person.id, person);
      const named = props.message.mentions.flatMap((id) => {
        const person = known.get(id);
        return person ? [{ id, name: displayName(person) }] : [];
      });
      return [mentionPlugin(named)];
    });

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
      if (!props.onEdit) return;
      const submitted = draft.value;
      const submittedMentions = mentions.value;
      // An unchanged edit cannot remove a mention whose name was not supplied in `people`.
      const savedMentions = submit.body === props.message.body
        ? [...new Set([...props.message.mentions, ...submit.mentions])]
        : submit.mentions;
      if (await run(() => props.onEdit?.(props.message.id, submit.body, savedMentions))
        && draft.value === submitted && mentions.value === submittedMentions) editing.value = false;
    }
    const canEdit = () => props.editable && props.onEdit !== undefined;
    const canDelete = () => (props.deletable ?? props.editable) && props.onDelete !== undefined;
    async function remove() {
      if (!props.onDelete) return;
      if (await run(() => props.onDelete?.(props.message.id))) confirming.value = false;
    }

    return () => {
      const { message } = props;
      return h(
        "div",
        { "data-compact": props.compact ? "true" : undefined, "data-editing": editing.value ? "true" : undefined, "data-slot": "comment-reply" },
        [
          h("div", { "data-slot": "comment-reply-content" }, [
            h("div", { "data-slot": "comment-reply-header" }, [
              h(AvatarStack, { "aria-hidden": "true", people: [toPerson(message.author)], size: "sm" }),
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
                }, slots["mention-item"] ? { "mention-item": slots["mention-item"] } : undefined)
              : (slots.body?.({ message }) ?? h(Markdown, {
                  components: bodyComponents,
                  "data-slot": "comment-reply-body",
                  plugins: bodyPlugins.value,
                  value: message.body,
                })),
            editing.value || props.compact ? null : (slots.attachments?.({ message }) ?? attachmentList(message, props.attachmentUrl, UIcon)),
            confirming.value
              ? h("div", { "aria-label": "Confirm delete", "data-slot": "comment-reply-confirm", role: "group" }, [
                  h("p", "Delete this comment and every reply to it?"),
                  h(UButton, { color: "error", label: "Delete thread", loading: busy.value, onClick: remove, size: "xs" }),
                  h(UButton, { color: "neutral", label: "Cancel", onClick: () => (confirming.value = false), size: "xs", variant: "ghost" }),
                ])
              : null,
            !editing.value && error.value ? h("p", { "data-slot": "comment-reply-error", role: "alert" }, error.value) : null,
          ]),
          (canEdit() || canDelete()) && !editing.value && !confirming.value && !props.compact
            ? h("div", { "data-slot": "comment-reply-actions" }, [
                canEdit() ? h(UButton, { "aria-label": "Edit", color: "neutral", icon: "i-ph-pencil-simple-light", onClick: startEdit, size: "xs", variant: "ghost" }) : null,
                canDelete() ? h(UButton, {
                  "aria-label": "Delete",
                  color: "neutral",
                  icon: "i-ph-trash-light",
                  onClick: () => (props.confirmDelete ? (confirming.value = true) : void remove()),
                  size: "xs",
                  variant: "ghost",
                }) : null,
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
    /** Keep the full thread readable without reply, edit, delete, or status controls. */
    readOnly: { default: false, type: Boolean },
    /** What the signed-in user may do: reply, resolve, edit, or delete. Defaults to the `can` of the comments state. */
    can: { type: Function as PropType<CommentCan> },
    /** Show a reply as being sent, on top of the thread's own tracking. */
    busy: { default: false, type: Boolean },
    /** An error to show, on top of the ones from the handlers. */
    error: { type: String },
    /** The thread is no longer on the page, so no pin shows where it was. */
    detached: { default: false, type: Boolean },
    /** People that messages may mention, on top of the authors of the thread. Their mentions show as chips. */
    people: { default: () => [], type: Array as PropType<CommentUser[]> },
    users: { type: Function as PropType<(query: string) => Promise<CommentUser[]>> },
    /** The reply box takes files. `onReply` gets them. */
    attachments: { default: true, type: Boolean },
    /** The file types that the reply box takes, such as `image/*`. */
    accept: { type: String },
    /** Gives the URL of an attachment key. With it, image attachments show as thumbnails. */
    attachmentUrl: { type: Function as PropType<CommentAttachmentUrl> },
    /** `"back"` shows a Back button at the start of the header instead of Close, for a thread inside a list. Both emit `close`. */
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    navigation: { default: "close", type: String as PropType<"close" | "back"> },
    /** A click outside the thread closes it. Turn it off when the thread is part of a panel. */
    dismissible: { default: true, type: Boolean },
    /** Sends a reply. Gets `(body, mentions, files)`. */
    onReply: { type: Function as PropType<(body: string, mentions: string[], files: File[]) => Done> },
    /** Saves an edited message. Gets `(messageId, body, mentions)`. */
    onEdit: { type: Function as PropType<(messageId: string, body: string, mentions: string[]) => Done> },
    /** Deletes a message. Gets `(messageId)`. Deleting the first message deletes the thread. */
    onDelete: { type: Function as PropType<(messageId: string) => Done> },
    onResolve: { type: Function as PropType<() => Done> },
    onReopen: { type: Function as PropType<() => Done> },
  },
  emits: ["close"],
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<CommentThreadSlots>,
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const comments = injectComments();
    const root = ref<HTMLElement | null>(null);
    const reply = ref("");
    const mentions = ref<string[]>([]);
    const files = ref<File[]>([]);
    const sending = ref(false);
    const failure = ref<string | undefined>();
    const composer = ref<{ focus: () => void } | null>(null);

    const user = computed(() => props.user ?? comments?.user.value);
    const allowed = (action: CommentThreadAction, message?: CommentMessage) =>
      !props.readOnly && (props.can ?? comments?.can ?? defaultCommentCan(user.value))(action, { message, thread: props.thread });
    const people = computed(() => {
      const seen = new Map<string, CommentUser>();
      for (const person of [...props.people, props.thread.author, ...props.thread.messages.map((message) => message.author), ...(user.value ? [user.value] : [])]) {
        seen.set(person.id, person);
      }
      return [...seen.values()];
    });
    const participants = computed(() => [...new Set([props.thread.author.id, ...props.thread.messages.map((message) => message.author.id)])]);

    // A click outside closes the thread, unless a reply is half written: then that box shakes.
    useDocumentPointerDown((event) => {
      const path = pathOf(event);
      if (props.preview || !props.dismissible || !root.value || path.includes(root.value)) return;
      if (path.some((element) => element.matches("[data-slot='comment-pin']")) || consumedPointerEvents.has(event)) return;
      consumedPointerEvents.add(event);
      const where = root.value.getRootNode();
      if (shakeDirtyComposers(where instanceof ShadowRoot ? where : document)) {
        event.stopPropagation();
        swallowNextClick();
      } else emit("close");
    });

    async function send(submit: CommentComposerSubmit) {
      if (sending.value || !props.onReply) return;
      sending.value = true;
      failure.value = undefined;
      const submitted = reply.value;
      const submittedMentions = mentions.value;
      const submittedFiles = files.value;
      try {
        await props.onReply(submit.body, [...submit.mentions], [...submit.files]);
        if (reply.value === submitted && mentions.value === submittedMentions && files.value === submittedFiles) {
          reply.value = "";
          mentions.value = [];
          files.value = [];
        }
        void nextTick(() => composer.value?.focus());
      } catch (cause) {
        failure.value = reason(cause);
      } finally {
        sending.value = false;
      }
    }
    // Resolve and Reopen show their failure too.
    async function act(task: (() => Done) | undefined) {
      if (root.value && shakeDirtyComposers(root.value)) return;
      failure.value = undefined;
      try {
        await task?.();
      } catch (cause) {
        failure.value = reason(cause);
      }
    }

    function close() {
      if (root.value && shakeDirtyComposers(root.value)) return;
      emit("close");
    }

    const replySlots = () => ({
      ...(slots.body ? { body: slots.body } : {}),
      ...(slots.attachments ? { attachments: slots.attachments } : {}),
      ...(slots["mention-item"] ? { "mention-item": slots["mention-item"] } : {}),
    });
    const composerSlots = () => ({
      ...(slots.extra ? { extra: slots.extra } : {}),
      ...(slots["mention-item"] ? { "mention-item": slots["mention-item"] } : {}),
    });

    return () => {
      const { thread } = props;
      const resolved = thread.status === "resolved";
      const first = thread.messages[0];
      const quote = thread.anchor.kind === "text" ? thread.anchor.exact : undefined;
      if (props.preview) {
        const replies = thread.messages.length - 1;
        return h("div", { "data-slot": "comment-thread", "data-preview": "true", "data-status": thread.status }, [
          first ? h(CommentReply, { compact: true, message: first, people: people.value, user: user.value }, slots.body ? { body: slots.body } : undefined) : null,
          replies > 0 ? h("p", { "data-slot": "comment-thread-count" }, `${replies} ${replies === 1 ? "reply" : "replies"}`) : null,
        ]);
      }
      const back = props.navigation === "back";
      const anchor = slots.anchor ? slots.anchor({ thread }) : quote ? h("blockquote", { "data-slot": "comment-thread-quote" }, quote) : null;
      return h(
        "section",
        { "aria-label": `Comment ${thread.n}`, "data-slot": "comment-thread", "data-status": thread.status, ref: root, role: "dialog", tabindex: -1 },
        [
          h("header", { "data-slot": "comment-thread-header" }, [
            back ? h(UButton, { "aria-label": "Back to comments", color: "neutral", icon: "i-ph-arrow-left", onClick: close, size: "xs", variant: "ghost" }) : null,
            h("span", { "data-slot": "comment-thread-title" }, `Comment ${thread.n}`),
            h("span", { "data-slot": "comment-thread-spacer" }),
            slots.actions ? h("div", { "data-slot": "comment-thread-actions" }, slots.actions({ thread })) : null,
            !allowed("resolve") ? null : h(UButton, {
              "aria-label": resolved ? "Reopen" : "Resolve",
              color: "neutral",
              icon: resolved ? "i-ph-arrow-counter-clockwise" : "i-ph-check",
              onClick: () => void act(resolved ? props.onReopen : props.onResolve),
              size: "xs",
              variant: "ghost",
            }),
            back ? null : h(UButton, { "aria-label": "Close", color: "neutral", icon: "i-ph-x-light", onClick: close, size: "xs", variant: "ghost" }),
          ]),
          h("div", { "data-slot": "comment-thread-messages" }, [
            anchor,
            props.detached
              ? h("p", { "data-slot": "comment-thread-detached", role: "status" }, "The place of this comment is no longer on the page.")
              : null,
            ...thread.messages.map((message, index) =>
              h(CommentReply, {
                attachmentUrl: props.attachmentUrl,
                confirmDelete: index === 0,
                deletable: allowed("delete", message),
                editable: allowed("edit", message),
                key: message.id,
                message,
                onDelete: props.onDelete,
                onEdit: props.onEdit,
                people: people.value,
                user: user.value,
                users: props.users,
              }, replySlots()),
            ),
            resolved
              ? h(Marker, { variant: "separator" }, () =>
                  h(MarkerContent, () => `Resolved${thread.resolvedBy ? ` by ${displayName(thread.resolvedBy)}` : ""}`),
                )
              : null,
            slots.after ? h("div", { "data-slot": "comment-thread-after" }, slots.after({ thread })) : null,
          ]),
          !allowed("reply") ? null : h(CommentComposer, {
            accept: props.accept,
            attachments: props.attachments,
            autofocus: false,
            busy: props.busy || sending.value,
            error: failure.value ?? props.error,
            files: files.value,
            guard: false,
            mentions: mentions.value,
            modelValue: reply.value,
            onCancel: close,
            onSubmit: send,
            participants: participants.value,
            "onUpdate:files": (value: File[]) => (files.value = value),
            "onUpdate:mentions": (value: string[]) => (mentions.value = value),
            "onUpdate:modelValue": (value: string) => (reply.value = value),
            people: people.value,
            ref: composer,
            user: user.value,
            users: props.users,
            variant: "reply",
          }, composerSlots()),
        ],
      );
    };
  },
});
