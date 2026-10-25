import type { CommentsClient, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, type PropType, reactive } from "vue";
import { draftPositionKey, provideComments, useComments, type CommentsState } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { consumedPointerEvents } from "../internal/comment-outside.ts";
import type { AvatarStackPerson } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSubmit } from "./comment-composer.ts";
import { CommentList, CommentToolbar } from "./comment-list.ts";
import { CommentPin } from "./comment-pin.ts";
import { CommentThread } from "./comment-thread.ts";

const popoverWidth = 360;
const popoverHeight = 420;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "That did not work. Try again.";
}

// The overlay of a page: pins on the spots that threads point at, the hover preview, the open thread, and the composer of
// a new comment. In comment mode a click anywhere drops a pin. It is built from the other comment parts.
// Give it a `client` and a `subject`, or the `comments` state from `useComments()`.
export const CommentLayer = defineComponent({
  name: "CommentLayer",
  props: {
    client: { type: Object as PropType<CommentsClient> },
    /** What the threads of this page are about. For a page, `{ kind: "page", id: "/pricing" }`. */
    subject: { type: Object as PropType<CommentSubject> },
    /** The signed-in user. Defaults to the client's user. */
    user: { type: Object as PropType<CommentUser> },
    /** A state from `useComments()`, instead of `client` and `subject`. */
    comments: { type: Object as PropType<CommentsState> },
    /** The people on this page, shown in the toolbar. */
    people: { default: () => [], type: Array as PropType<AvatarStackPerson[]> },
    /** The key that toggles comment mode. `false` turns it off. */
    hotkey: { default: "c", type: [String, Boolean] as PropType<string | false> },
    /** Navigates to the page of a thread from the list. Defaults to `location.assign`. */
    navigate: { type: Function as PropType<(href: string) => void> },
  },
  setup(props, { slots }) {
    const { client, subject } = props;
    if (!props.comments && (!client || !subject)) {
      throw uiErrorDiagnostics.UI_R0002({
        message: "CommentLayer needs a `client` and a `subject`, or the `comments` state from useComments().",
      });
    }
    // SAFETY: the check above leaves `client` and `subject` defined whenever `props.comments` is missing.
    const state = props.comments ?? useComments({
      client: client!,
      hotkey: props.hotkey,
      subject: () => props.subject!,
      user: () => props.user,
    });
    provideComments(state);

    // Per thread, so a failed reply on one thread does not show on another.
    const status = reactive<Record<string, { busy: boolean; error?: string }>>({});
    async function run(id: string, task: Promise<unknown>): Promise<boolean> {
      status[id] = { busy: true };
      try {
        await task;
        status[id] = { busy: false };
        return true;
      } catch (error) {
        status[id] = { busy: false, error: reason(error) };
        return false;
      }
    }

    const user = computed(() => state.user.value);
    const pinned = computed(() => {
      const threads = [...state.pageThreads.value];
      const opened = state.opened.value;
      if (opened && opened.subject.kind === state.subject.value.kind && opened.subject.id === state.subject.value.id && !threads.includes(opened)) threads.push(opened);
      return threads;
    });

    const place = (event: PointerEvent) => {
      if (consumedPointerEvents.has(event) || event.button !== 0) return;
      event.preventDefault();
      try {
        state.startDraft({ x: event.clientX, y: event.clientY });
      } catch {
        // Nothing of the page is under the pointer, so there is nothing to comment on.
      }
    };

    const side = (x: number, y: number) => ({
      "data-flip-x": x + popoverWidth > window.innerWidth ? "true" : undefined,
      "data-flip-y": y + popoverHeight > window.innerHeight ? "true" : undefined,
    });

    const threadView = (thread: CommentThreadModel) =>
      h(CommentThread, {
        busy: status[thread.id]?.busy ?? false,
        detached: state.positions.value.get(thread.id)?.detached === true,
        error: status[thread.id]?.error,
        onClose: () => state.close(),
        onDelete: (messageId: string) => void run(thread.id, state.remove(thread.id, messageId)),
        onEdit: (messageId: string, body: string, mentions: string[]) =>
          void run(thread.id, state.edit(thread.id, messageId, body, mentions)),
        onReopen: () => void run(thread.id, state.reopen(thread.id)),
        onReply: (body: string, mentions: string[]) => void run(thread.id, state.reply(thread.id, body, mentions)),
        // Resolving puts the thread away, as in Figma.
        onResolve: () => void run(thread.id, state.resolve(thread.id)).then((done) => done && state.close()),
        thread,
        user: user.value,
        users: state.users,
      });

    return () => {
      const items = pinned.value.flatMap((thread) => {
        const position = state.positions.value.get(thread.id);
        if (!position || position.detached || thread.anchor.kind === "page") return [];
        const open = state.openId.value === thread.id;
        const hover = state.hoverId.value === thread.id && !open && !state.draft.value;
        return [
          h(
            "div",
            {
              ...side(position.x, position.y),
              "data-slot": "comment-layer-item",
              key: thread.id,
              style: { left: `${position.x}px`, top: `${position.y}px` },
            },
            [
              h(CommentPin, {
                active: open,
                author: thread.author,
                n: thread.n,
                onHover: () => {
                  if (!open && !state.draft.value) state.hoverId.value = thread.id;
                },
                onLeave: () => {
                  if (state.hoverId.value === thread.id) state.hoverId.value = null;
                },
                onSelect: () => (open ? state.close() : state.open(thread)),
                status: thread.status,
              }),
              open
                ? h("div", { "data-slot": "comment-layer-popover" }, threadView(thread))
                : hover
                  ? h("div", { "data-preview": "true", "data-slot": "comment-layer-popover" }, h(CommentThread, { preview: true, thread }))
                  : null,
            ],
          ),
        ];
      });

      // An open thread without a pin on the page, such as a detached one, shows in a corner.
      const opened = state.opened.value;
      const openedPosition = opened && state.positions.value.get(opened.id);
      const floating =
        opened && (!openedPosition || openedPosition.detached || opened.anchor.kind === "page")
          ? h("div", { "data-floating": "true", "data-slot": "comment-layer-popover" }, threadView(opened))
          : null;

      const draft = state.draft.value;
      const draftPosition = draft && state.positions.value.get(draftPositionKey);
      const point = draftPosition && !draftPosition.detached ? draftPosition : draft?.point;
      const composing =
        draft && point
          ? h(
              "div",
              {
                ...side(point.x, point.y),
                "data-draft": "true",
                "data-slot": "comment-layer-item",
                style: { left: `${point.x}px`, top: `${point.y}px` },
              },
              [
                h(CommentPin, { author: user.value, draft: true, n: state.nextNumber.value }),
                h(
                  "div",
                  { "data-slot": "comment-layer-popover" },
                  h(CommentComposer, {
                    busy: draft.busy,
                    error: draft.error,
                    mentions: draft.mentions,
                    modelValue: draft.body,
                    onCancel: () => state.cancelDraft(),
                    onSubmit: (submit: CommentComposerSubmit) => {
                      draft.mentions = submit.mentions;
                      void state.send();
                    },
                    "onUpdate:mentions": (value: string[]) => (draft.mentions = value),
                    "onUpdate:modelValue": (value: string) => (draft.body = value),
                    user: user.value,
                    users: state.users,
                  }),
                ),
              ],
            )
          : null;

      return h(
        "div",
        { "data-active": state.active.value ? "true" : undefined, "data-comments-ui": "", "data-slot": "comment-layer" },
        [
          state.active.value ? h("div", { "data-slot": "comment-layer-overlay", onPointerdown: place }) : null,
          ...items,
          composing,
          floating,
          slots.default?.({ comments: state }) ?? [
            h(CommentToolbar, { comments: state, people: props.people }),
            state.listOpen.value ? h(CommentList, { comments: state, navigate: props.navigate }) : null,
          ],
        ],
      );
    };
  },
});
