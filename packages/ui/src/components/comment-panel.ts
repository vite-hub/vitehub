import type { CommentsClient, CommentStatus, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, type PropType, ref, type SlotsType, type VNode, watch } from "vue";
import { RollNumber } from "./motion.ts";
import { type CommentCan, type CommentsState, provideComments, useComments, useCommentsContext } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { useCommentAttachments } from "../internal/comment-attachments.ts";
import { rowSlotScope, threadRow } from "../internal/comment-row.ts";
import { commentThreadKey, useSelectedComment } from "../internal/comment-selection.ts";
import { commentTitle, deliveryAttributes, repliedSinceResolved } from "../internal/comment-status.ts";
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

export const CommentPanel = defineComponent({
  name: "CommentPanel",
  props: {
    comments: { type: Object as PropType<CommentsState> },
    client: { type: Object as PropType<CommentsClient> },
    subject: { type: Object as PropType<CommentSubject> },
    user: { type: Object as PropType<CommentUser> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    variant: { default: "docked", type: String as PropType<CommentPanelVariant> },
    thread: { default: undefined, type: [String, null] as PropType<string | null> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    status: { type: String as PropType<CommentStatus> },
    title: { default: "Comments", type: String },
    readOnly: { default: false, type: Boolean },
    upload: { type: Function as PropType<CommentUpload> },
    queueFiles: { default: false, type: Boolean },
    accept: { type: String },
    attachmentUrl: { type: Function as PropType<CommentAttachmentUrl> },
    allowEmpty: { default: false, type: Boolean },
    people: { default: () => [], type: Array as PropType<CommentUser[]> },
    can: { type: Function as PropType<CommentCan> },
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
    const rows = computed(() =>
      scoped.value.filter((thread) => thread.status === status.value || (status.value === "open" && repliedSinceResolved(thread))),
    );
    const opened = useSelectedComment(state.threads, threadId);

    watch(opened, (thread, _previous, onCleanup) => {
      if (thread) onCleanup(state.retainMark(thread.id));
    }, { immediate: true, flush: "sync" });
    watch(opened, thread => {
      if (thread && thread.id !== threadId.value) setThread(thread.id);
    });

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
      const id = opened.value?.id;
      setThread(null);
      void nextTick(() => {
        const rowsOf = root.value?.querySelectorAll<HTMLElement>("[data-slot='comment-panel-item']") ?? [];
        [...rowsOf].find((row) => row.dataset.threadId === id)?.focus();
      });
    }
    const { enabled: attachmentsOn, prepare, queued } = useCommentAttachments(state, props);

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
      failure.value = undefined;
      const submitted = { body: body.value, files: files.value, mentions: mentions.value };
      const queuedFiles = queued(submit.files);
      if (queuedFiles) {
        body.value = "";
        mentions.value = [];
        files.value = [];
        try {
          await state.create({ files: queuedFiles, body: submit.body, mentions: submit.mentions });
        } catch (cause) {
          if (run !== sending) return;
          failure.value = reason(cause);
          if (!body.value && !files.value.length) {
            body.value = submitted.body;
            mentions.value = submitted.mentions;
            files.value = submitted.files;
          }
        }
        return;
      }
      busy.value = true;
      try {
        const attached = await prepare(submit.files);
        if (run !== sending) return;
        await state.create({ ...attached, body: submit.body, mentions: submit.mentions });
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
        const label = props.group
          ? props.group(thread)
          : status.value === "open" && thread.status === "resolved" ? "Replied since resolved" : undefined;
        let entry = found.find((group) => group.label === label);
        if (!entry) found.push((entry = { label, threads: [] }));
        entry.threads.push(thread);
      }
      return found.sort((a, b) => Number(a.label !== undefined) - Number(b.label !== undefined));
    });
    const row = (thread: CommentThreadModel) =>
      h("li", { key: thread.id }, [
        h(
          "button",
          {
            "data-focus-inset": "",
            "data-slot": "comment-panel-item",
            "data-status": thread.status,
            ...deliveryAttributes(thread.delivery),
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
          "aria-checked": String(status.value === value),
          color: "neutral",
          "data-slot": "comment-panel-filter",
          "data-state": status.value === value ? "on" : "off",
          onClick: () => setStatus(value),
          onKeydown: (event: KeyboardEvent) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const group = (event.currentTarget as HTMLElement).closest("[role=radiogroup]");
            setStatus(value === "open" ? "resolved" : "open");
            void nextTick(() => group?.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus());
          },
          role: "radio",
          size: "xs",
          tabindex: status.value === value ? 0 : -1,
          variant: status.value === value ? "soft" : "ghost",
        }, { default: () => [`${label} `, h(RollNumber, { value: count })] });
      const empty = state.status.value === "loading" && state.threads.value.length === 0
        ? "Loading comments."
        : state.status.value === "error"
          ? "The comments could not load."
          : status.value === "open" ? "No open comments." : "No resolved comments.";
      return [
        h("header", { "data-slot": "comment-panel-header" }, [
          h("h2", { "data-slot": "comment-panel-title" }, props.title),
          h("div", { "aria-label": "Filter comments", "data-slot": "comment-panel-filters", role: "radiogroup" }, [
            filter("open", "Open", counts.open),
            filter("resolved", "Resolved", counts.resolved),
          ]),
          slots["list-actions"] ? h("div", { "data-slot": "comment-panel-actions" }, slots["list-actions"]()) : null,
        ]),
        rows.value.length === 0
          ? h("p", { "data-slot": "comment-panel-empty", role: "status" }, empty)
          : props.group || groups.value.some((group) => group.label !== undefined)
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
                layout: "row",
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
                ...(slots["mention-empty"] ? { "mention-empty": slots["mention-empty"] } : {}),
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
        key: commentThreadKey(thread),
        navigation: "back",
        onClose: back,
        onDelete: async (messageId: string) => {
          if (!(await state.remove(thread.id, messageId))) back();
        },
        onEdit: (messageId: string, text: string, ids: string[]) => state.edit(thread.id, messageId, text, ids),
        onReopen: () => state.reopen(thread.id),
        onReply: async (text: string, ids: string[], list: File[]) => {
          const { attachments, files } = await prepare(list);
          return state.reply(thread.id, text, ids, attachments, files);
        },
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
          "aria-label": opened.value ? commentTitle(opened.value) : props.title,
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
