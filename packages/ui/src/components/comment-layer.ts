import type { CommentsClient, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, type PropType, ref, watch } from "vue";
import { draftPositionKey, provideComments, useComments, type CommentsState } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { consumedPointerEvents } from "../internal/comment-outside.ts";
import { excerpt } from "../internal/comment-person.ts";
import type { AvatarStackPerson } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSubmit } from "./comment-composer.ts";
import { CommentList, CommentToolbar } from "./comment-list.ts";
import { CommentPin } from "./comment-pin.ts";
import { CommentThread } from "./comment-thread.ts";

const popoverWidth = 360;
const popoverHeight = 420;

// A pointer that moved more than this between down and up was a scroll or a drag, not a click.
const clickSlop = 6;

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
    /** Hide thread mutation controls when the viewer may only read. */
    readOnly: { default: false, type: Boolean },
    /** The URL of the page that a subject lives on, for the links of threads that are not page threads. */
    subjectUrl: { type: Function as PropType<(subject: CommentSubject) => string | undefined> },
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
    const layer = ref<HTMLElement | null>(null);
    // The comment UI may live in a shadow root. Composers are looked up there, not in the document.
    const uiRoot = () => {
      const node = layer.value?.getRootNode();
      return node instanceof ShadowRoot ? node : document;
    };
    // SAFETY: the check above leaves `client` and `subject` defined whenever `props.comments` is missing.
    const state = props.comments ?? useComments({
      client: client!,
      hotkey: props.hotkey,
      subject: () => props.subject!,
      subjectUrl: props.subjectUrl,
      uiRoot,
      user: () => props.user,
    });
    provideComments(state);

    const user = computed(() => state.user.value);
    const pinned = computed(() => {
      const threads = [...state.pageThreads.value];
      const opened = state.opened.value;
      if (opened && opened.subject.kind === state.subject.value.kind && opened.subject.id === state.subject.value.id && !threads.includes(opened)) threads.push(opened);
      return threads;
    });

    // A pin drops on pointer up, and only if the pointer stayed put: a touch that scrolls the page is not a click.
    let down: { x: number; y: number } | null = null;
    const press = (event: PointerEvent) => {
      down = consumedPointerEvents.has(event) || event.button !== 0 ? null : { x: event.clientX, y: event.clientY };
    };
    const release = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > clickSlop) return;
      event.preventDefault();
      try {
        state.startDraft({ x: event.clientX, y: event.clientY });
      } catch {
        // Nothing of the page is under the pointer, so there is nothing to comment on.
      }
    };

    // Opening a thread moves the focus into it. Closing it gives the focus back to its pin, unless the reader already went elsewhere.
    let returnTo: string | null = null;
    let restoring = false;
    watch(
      () => state.openId.value,
      (id, previous) => {
        if (id) {
          void nextTick(() => layer.value?.querySelector<HTMLElement>("[data-slot='comment-thread']:not([data-preview])")?.focus());
          return;
        }
        returnTo = null;
        const active = uiRoot().activeElement;
        const thread = layer.value?.querySelector("[data-slot='comment-thread']:not([data-preview])");
        if (previous && (!active || active === document.body || thread?.contains(active))) returnTo = previous;
      },
      { flush: "pre" },
    );
    watch(
      () => state.openId.value,
      (id) => {
        if (id || !returnTo) return;
        const target = returnTo;
        returnTo = null;
        void nextTick(() => {
          const pins = layer.value?.querySelectorAll<HTMLElement>("[data-slot='comment-pin']") ?? [];
          // Giving the focus back must not open the hover preview of the pin.
          restoring = true;
          [...pins].find((pin) => pin.getAttribute("data-thread-id") === target)?.focus();
          restoring = false;
        });
      },
      { flush: "post" },
    );
    const side = (x: number, y: number) => ({
      "data-flip-x": x + popoverWidth > window.innerWidth ? "true" : undefined,
      "data-flip-y": y + popoverHeight > window.innerHeight ? "true" : undefined,
    });

    // The thread tracks each action itself: it clears a box only after the handler succeeded, and shows a failure.
    const threadView = (thread: CommentThreadModel) =>
      h(CommentThread, {
        detached: state.positions.value.get(thread.id)?.detached === true,
        readOnly: props.readOnly,
        onClose: () => state.close(),
        onDelete: (messageId: string) => state.remove(thread.id, messageId),
        onEdit: (messageId: string, body: string, mentions: string[]) => state.edit(thread.id, messageId, body, mentions),
        onReopen: () => state.reopen(thread.id),
        onReply: (body: string, mentions: string[]) => state.reply(thread.id, body, mentions),
        // Resolving puts the thread away, as in Figma.
        onResolve: async () => {
          await state.resolve(thread.id);
          state.close();
        },
        thread,
        user: user.value,
        users: state.users,
      });

    return () => {
      const items = pinned.value.flatMap((thread) => {
        const position = state.positions.value.get(thread.id);
        if (!position || position.detached || position.clipped || thread.anchor.kind === "page") return [];
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
                "data-thread-id": thread.id,
                excerpt: excerpt(thread.messages[0]?.body ?? ""),
                n: thread.n,
                onHover: () => {
                  if (!open && !restoring && !state.draft.value) state.hoverId.value = thread.id;
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
        opened && (!openedPosition || openedPosition.detached || openedPosition.clipped || opened.anchor.kind === "page")
          ? h("div", { "data-floating": "true", "data-slot": "comment-layer-popover" }, threadView(opened))
          : null;

      const draft = state.draft.value;
      const draftPosition = draft && state.positions.value.get(draftPositionKey);
      // A comment on the whole page has no spot, so its composer stays where it opened.
      const point = draftPosition && !draftPosition.detached && draft?.anchor.kind !== "page" ? draftPosition : draft?.point;
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
                h(CommentPin, { author: user.value, draft: true }),
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
                    people: user.value ? [user.value] : [],
                    user: user.value,
                    users: state.users,
                  }),
                ),
              ],
            )
          : null;

      return h(
        "div",
        { "data-active": state.active.value ? "true" : undefined, "data-comments-ui": "", "data-slot": "comment-layer", ref: layer },
        [
          state.active.value
            ? h("div", {
                "data-slot": "comment-layer-overlay",
                onPointercancel: () => (down = null),
                onPointerdown: press,
                onPointerup: release,
              })
            : null,
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
