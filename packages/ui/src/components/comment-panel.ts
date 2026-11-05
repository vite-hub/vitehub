import type { CommentsClient, CommentStatus, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, type PropType, ref, type SlotsType, type VNode, watch } from "vue";
import { type CommentCan, type CommentsState, provideComments, useComments, useCommentsContext } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { rowSlotScope, threadRow } from "../internal/comment-row.ts";
import { injectComments } from "../internal/comments-context.ts";
import { CommentComposer, type CommentComposerSubmit } from "./comment-composer.ts";
import { type CommentAttachmentUrl, CommentThread, type CommentThreadSlots } from "./comment-thread.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

export type CommentPanelVariant = "docked" | "floating";

/** Turns files into attachment keys, such as Blob keys, before a comment or a reply is sent. */
export type CommentUpload = (files: File[]) => Promise<string[]>;

/** The scope of the `row` and `preview` slots of `CommentPanel` and `CommentList`. */
export interface CommentRowSlotScope {
  thread: CommentThreadModel;
  /** The text that the row shows without a `preview` slot: the first message as plain text, else the quoted text. */
  text: string;
}

/** The scope of the `group-header` slot: the label that `group` gave, and the threads under it. */
export interface CommentGroupSlotScope {
  group: string;
  threads: CommentThreadModel[];
}

export type CommentRowSlots = {
  /** The inside of one row of the list. Replaces the number, avatar, text, and facts. */
  row?: (scope: CommentRowSlotScope) => VNode[];
  /** The text of one row. Replaces the start of the first message, as plain text. Render `text` to keep it for some rows. */
  preview?: (scope: CommentRowSlotScope) => VNode[];
};

export type CommentPanelSlots = CommentThreadSlots & CommentRowSlots & {
  /** The heading of a group of rows. Replaces the label that `group` gave. */
  "group-header"?: (scope: CommentGroupSlotScope) => VNode[];
  /** Buttons at the end of the list's top row, beside Open and Resolved, such as Close. */
  "list-actions"?: () => VNode[];
};

/** Puts a thread under a heading of the list, such as `"From earlier versions"`. `undefined` keeps it in the first, unnamed group. */
export type CommentGroup = (thread: CommentThreadModel) => string | undefined;

const listSlots = new Set(["row", "preview", "group-header", "list-actions"]);

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "The comment could not be sent. Try again.";
}

const sameSubject = (a: CommentSubject, b: CommentSubject) => a.kind === b.kind && a.id === b.id;

// One surface for the comments of a page: the list of threads, one open thread with a Back button, and a box at the
// bottom that comments on the whole page. Open and Resolved switch the list. It is the side panel of a review tool.
export const CommentPanel = defineComponent({
  name: "CommentPanel",
  props: {
    /** A state from `useComments()`. Defaults to the state of the nearest `CommentLayer` or `provideComments()`. */
    comments: { type: Object as PropType<CommentsState> },
    /** The client, for a panel that is not inside a `CommentLayer`. Give it with `subject`. */
    client: { type: Object as PropType<CommentsClient> },
    /** What the threads are about, with `client`. */
    subject: { type: Object as PropType<CommentSubject> },
    /** The signed-in user, with `client`. Defaults to the client's user. */
    user: { type: Object as PropType<CommentUser> },
    /** `docked` fills its container, such as a side column. `floating` is a card over the page. */
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    variant: { default: "docked", type: String as PropType<CommentPanelVariant> },
    /** The id of the open thread. Use `v-model:thread`. `null` shows the list. */
    thread: { default: undefined, type: [String, null] as PropType<string | null> },
    /** Which threads the list shows. Use `v-model:status`. */
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    status: { type: String as PropType<CommentStatus> },
    /** The heading of the list. */
    title: { default: "Comments", type: String },
    /** Hide the page box and every reply, edit, delete, and status control. */
    readOnly: { default: false, type: Boolean },
    /** Turns attached files into attachment keys. Without it the boxes take no files. */
    upload: { type: Function as PropType<CommentUpload> },
    /** The file types that the boxes take, such as `image/*`. */
    accept: { type: String },
    /** Gives the URL of an attachment key. With it, image attachments show as thumbnails. */
    attachmentUrl: { type: Function as PropType<CommentAttachmentUrl> },
    /** Send a new page comment that has files and no text. */
    allowEmpty: { default: false, type: Boolean },
    /** People that messages may mention, on top of the people that the comments state knows. */
    people: { default: () => [], type: Array as PropType<CommentUser[]> },
    /** What the signed-in user may do in a thread. Defaults to the `can` of the comments state. */
    can: { type: Function as PropType<CommentCan> },
    /** Groups the rows under headings, in the order the groups first appear. Threads without a group come first. */
    group: { type: Function as PropType<CommentGroup> },
  },
  emits: ["update:thread", "update:status", "select"],
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<CommentPanelSlots>,
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const inherited = props.comments ?? injectComments();
    if (!inherited && (!props.client || !props.subject)) {
      throw uiErrorDiagnostics.UI_R0002({
        message: "CommentPanel needs a comments state: put it inside CommentLayer, pass `comments`, or pass a `client` and a `subject`.",
      });
    }
    // SAFETY: the check above leaves `client` and `subject` defined whenever no state was found.
    // A panel of its own has no comment mode, so it takes no hotkey.
    const state = useCommentsContext(inherited ?? useComments({ client: props.client!, hotkey: false, subject: () => props.subject!, user: () => props.user }));
    provideComments(state);

    const root = ref<HTMLElement | null>(null);
    const localThread = ref<string | null>(null);
    const localStatus = ref<CommentStatus>("open");
    const threadId = computed(() => (props.thread === undefined ? localThread.value : props.thread));
    const status = computed(() => props.status ?? localStatus.value);
    const scoped = computed(() =>
      state.threads.value.filter((thread) => state.scope.value === "site" || sameSubject(thread.subject, state.subject.value)),
    );
    const rows = computed(() => scoped.value.filter((thread) => thread.status === status.value));
    const opened = computed(() => (threadId.value ? state.threads.value.find((thread) => thread.id === threadId.value) : undefined));

    const body = ref("");
    const mentions = ref<string[]>([]);
    const files = ref<File[]>([]);
    const busy = ref(false);
    const failure = ref<string | undefined>();

    function setThread(id: string | null) {
      localThread.value = id;
      emit("update:thread", id);
    }
    function setStatus(value: CommentStatus) {
      localStatus.value = value;
      emit("update:status", value);
    }
    function select(thread: CommentThreadModel) {
      emit("select", thread);
      setThread(thread.id);
      void nextTick(() => root.value?.querySelector<HTMLElement>("[data-slot='comment-thread']")?.focus());
    }
    function back() {
      const id = threadId.value;
      setThread(null);
      void nextTick(() => {
        const rowsOf = root.value?.querySelectorAll<HTMLElement>("[data-slot='comment-panel-item']") ?? [];
        [...rowsOf].find((row) => row.dataset.threadId === id)?.focus();
      });
    }
    const attachmentsOn = computed(() => props.upload !== undefined && state.client.transport.supportsAttachments !== false);
    const keys = async (list: File[]) => (attachmentsOn.value && list.length > 0 && props.upload ? props.upload(list) : []);

    // The page box belongs to one subject. Another subject starts with an empty, ready box, and a send that is still on
    // its way for the old subject no longer touches it.
    const subjectKey = () => `${state.subject.value.kind}\u0000${state.subject.value.id}`;
    let sending = 0;
    watch(subjectKey, () => {
      sending++;
      body.value = "";
      mentions.value = [];
      files.value = [];
      failure.value = undefined;
      busy.value = false;
    });

    async function send(submit: CommentComposerSubmit) {
      if (busy.value) return;
      const run = ++sending;
      busy.value = true;
      failure.value = undefined;
      const submitted = { body: body.value, files: files.value, mentions: mentions.value };
      try {
        const attachments = await keys(submit.files);
        // A comment written on one page never goes to the next one, even when the subject changed during the upload.
        if (run !== sending) return;
        await state.create({ attachments, body: submit.body, mentions: submit.mentions });
        if (run === sending && body.value === submitted.body && files.value === submitted.files && mentions.value === submitted.mentions) {
          body.value = "";
          mentions.value = [];
          files.value = [];
        }
      } catch (cause) {
        if (run === sending) failure.value = reason(cause);
      } finally {
        if (run === sending) busy.value = false;
      }
    }

    const threadSlots = () => Object.fromEntries(Object.entries(slots).filter(([name, slot]) => slot !== undefined && !listSlots.has(name)));
    const groups = computed(() => {
      const found: Array<{ label: string | undefined; threads: CommentThreadModel[] }> = [];
      for (const thread of rows.value) {
        const label = props.group?.(thread);
        let entry = found.find((group) => group.label === label);
        if (!entry) found.push((entry = { label, threads: [] }));
        entry.threads.push(thread);
      }
      // Threads without a group lead, so a heading such as "From earlier versions" sits below the current ones.
      return found.sort((a, b) => Number(a.label !== undefined) - Number(b.label !== undefined));
    });
    const row = (thread: CommentThreadModel) =>
      h("li", { key: thread.id }, [
        h(
          "button",
          {
            "data-slot": "comment-panel-item",
            "data-status": thread.status,
            "data-thread-id": thread.id,
            onClick: () => select(thread),
            type: "button",
          },
          slots.row?.(rowSlotScope(thread)) ?? threadRow(thread, {
            detached: state.positions.value.get(thread.id)?.detached === true,
            preview: slots.preview?.(rowSlotScope(thread)),
            site: state.scope.value === "site",
          }),
        ),
      ]);
    const items = (threads: CommentThreadModel[], label: string, key?: string) => h("ol", { "aria-label": label, "data-slot": "comment-panel-items", key }, threads.map(row));
    const grouped = () =>
      groups.value.map(({ label, threads }) =>
        label === undefined
          ? items(threads, props.title, "ungrouped")
          : h("section", { "aria-label": label, "data-slot": "comment-panel-group", key: label }, [
              h("h3", { "data-slot": "comment-panel-group-header" }, slots["group-header"]?.({ group: label, threads }) ?? label),
              items(threads, label),
            ]),
      );

    const list = () => {
      const counts = state.counts.value;
      const filter = (value: CommentStatus, label: string, count: number) =>
        h(UButton, {
          "aria-pressed": String(status.value === value),
          color: "neutral",
          "data-slot": "comment-panel-filter",
          "data-state": status.value === value ? "on" : "off",
          label: `${label} ${count}`,
          onClick: () => setStatus(value),
          size: "xs",
          variant: status.value === value ? "soft" : "ghost",
        });
      const empty = state.status.value === "loading" && state.threads.value.length === 0
        ? "Loading comments."
        : state.status.value === "error"
          ? "The comments could not load."
          : status.value === "open" ? "No open comments." : "No resolved comments.";
      return [
        h("header", { "data-slot": "comment-panel-header" }, [
          h("h2", { "data-slot": "comment-panel-title" }, props.title),
          h("div", { "aria-label": "Filter comments", "data-slot": "comment-panel-filters", role: "group" }, [
            filter("open", "Open", counts.open),
            filter("resolved", "Resolved", counts.resolved),
          ]),
          slots["list-actions"] ? h("div", { "data-slot": "comment-panel-actions" }, slots["list-actions"]()) : null,
        ]),
        rows.value.length === 0
          ? h("p", { "data-slot": "comment-panel-empty", role: "status" }, empty)
          : props.group
            ? h("div", { "data-slot": "comment-panel-groups" }, grouped())
            : items(rows.value, props.title),
        props.readOnly
          ? null
          : h("div", { "data-slot": "comment-panel-composer" }, [
              h(CommentComposer, {
                accept: props.accept,
                allowEmpty: props.allowEmpty,
                attachments: attachmentsOn.value,
                autofocus: false,
                busy: busy.value,
                error: failure.value,
                files: files.value,
                guard: false,
                mentions: mentions.value,
                modelValue: body.value,
                onSubmit: send,
                "onUpdate:files": (value: File[]) => (files.value = value),
                "onUpdate:mentions": (value: string[]) => (mentions.value = value),
                "onUpdate:modelValue": (value: string) => (body.value = value),
                people: props.people,
                placeholder: "Comment on this page",
                user: state.user.value,
              }, {
                ...(slots.extra ? { extra: slots.extra } : {}),
                ...(slots["mention-item"] ? { "mention-item": slots["mention-item"] } : {}),
              }),
            ]),
      ];
    };

    const threadView = (thread: CommentThreadModel) =>
      h(CommentThread, {
        accept: props.accept,
        attachmentUrl: props.attachmentUrl,
        attachments: attachmentsOn.value,
        can: props.can,
        detached: state.positions.value.get(thread.id)?.detached === true,
        dismissible: false,
        key: thread.id,
        navigation: "back",
        onClose: back,
        onDelete: async (messageId: string) => {
          if (!(await state.remove(thread.id, messageId))) back();
        },
        onEdit: (messageId: string, text: string, ids: string[]) => state.edit(thread.id, messageId, text, ids),
        onReopen: () => state.reopen(thread.id),
        onReply: async (text: string, ids: string[], attached: File[]) => state.reply(thread.id, text, ids, await keys(attached)),
        onResolve: () => state.resolve(thread.id),
        people: props.people,
        readOnly: props.readOnly,
        thread,
        user: state.user.value,
      }, threadSlots());

    return () =>
      h(
        "section",
        {
          "aria-label": opened.value ? `Comment ${opened.value.n}` : props.title,
          "data-comments-ui": "",
          "data-slot": "comment-panel",
          "data-variant": props.variant,
          "data-view": opened.value ? "thread" : "list",
          ref: root,
        },
        opened.value ? threadView(opened.value) : list(),
      );
  },
});
