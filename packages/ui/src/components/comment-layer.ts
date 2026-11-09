import type { AnchorPosition, CommentsClient, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, type PropType, ref, shallowRef, watch } from "vue";
import { type CommentCan, draftPositionKey, provideComments, useComments, type CommentDraft, type CommentsState } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { consumedPointerEvents } from "../internal/comment-outside.ts";
import { excerpt } from "../internal/comment-person.ts";
import type { AvatarStackPerson } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSubmit } from "./comment-composer.ts";
import { CommentList, CommentToolbar } from "./comment-list.ts";
import { CommentPin } from "./comment-pin.ts";
import type { CommentUpload } from "./comment-panel.ts";
import { type CommentAttachmentUrl, CommentThread } from "./comment-thread.ts";

const popoverWidth = 360;
const popoverHeight = 420;

// A pointer that moved more than this between down and up was a scroll or a drag, not a click.
const clickSlop = 6;
// The room of one pin. Pins closer than this to each other stack.
const pinSpacing = 32;
// A drag in comment mode draws an area. A smaller one is a slip, not an area.
const minimumArea = 8;

type Box = { left: number; top: number; width: number; height: number };

// The element of the page that holds the whole box: the innermost one under its center whose box contains it. The
// comment UI, the shadow hosts of the page tools, and the root are not the page. Without such an element there is no
// container: an anchor on a smaller element would cut the box.
function containerOf(box: Box): Element | undefined {
  const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const under = document.elementsFromPoint(center.x, center.y).find((element) => !element.closest("[data-comments-ui]") && !element.localName.startsWith("vitehub-") && element !== document.documentElement);
  for (let element: Element | null = under ?? null; element && element !== document.documentElement; element = element.parentElement) {
    const rect = element.getBoundingClientRect();
    if (rect.left <= box.left + 1 && rect.top <= box.top + 1 && rect.right >= box.left + box.width - 1 && rect.bottom >= box.top + box.height - 1) return element;
  }
  return undefined;
}

// The overlay of a page: pins on the spots that threads point at, the hover preview, the open thread, and the composer of
// a new comment. In comment mode a click anywhere drops a pin, and a drag draws an area. It is built from the other
// comment parts. Each item says the kind of its anchor in `data-kind`, so a pin can sit by a quote or on an area.
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
    /** What the signed-in user may do in a thread. Defaults to the `can` of the comments state. */
    can: { type: Function as PropType<CommentCan> },
    /** Turns attached files into attachment keys. Without it the boxes take no files. */
    upload: { type: Function as PropType<CommentUpload> },
    /** The file types that the boxes take, such as `image/*`. */
    accept: { type: String },
    /** Gives the URL of an attachment key. With it, image attachments show as thumbnails. */
    attachmentUrl: { type: Function as PropType<CommentAttachmentUrl> },
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
    const draftFiles = ref<File[]>([]);
    const uploadingDraft = shallowRef<CommentDraft | null>(null);
    // The files belong to one draft. A new draft, or none, starts without them.
    watch(() => state.draft.value, (next, previous) => {
      if (next !== previous) draftFiles.value = [];
    });
    const attachmentsOn = computed(() => props.upload !== undefined && state.client.transport.supportsAttachments !== false);
    const keys = async (files: File[]) => (attachmentsOn.value && files.length > 0 && props.upload ? props.upload(files) : []);

    const user = computed(() => state.user.value);
    const pinned = computed(() => {
      const threads = [...state.pageThreads.value];
      const opened = state.opened.value;
      if (opened && opened.subject.kind === state.subject.value.kind && opened.subject.id === state.subject.value.id && !threads.includes(opened)) threads.push(opened);
      return threads;
    });

    // A pin drops on pointer up, and only if the pointer stayed put: a touch that scrolls the page is not a click. A mouse
    // or a pen that moves draws an area instead, and the area becomes the comment's anchor.
    let down: { x: number; y: number; draw: boolean } | null = null;
    const drawing = ref<Box | null>(null);
    const boxFrom = (start: { x: number; y: number }, event: PointerEvent): Box => ({
      left: Math.min(start.x, event.clientX),
      top: Math.min(start.y, event.clientY),
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    });
    const press = (event: PointerEvent) => {
      drawing.value = null;
      down = consumedPointerEvents.has(event) || event.button !== 0 ? null : { x: event.clientX, y: event.clientY, draw: event.pointerType !== "touch" };
      if (down?.draw && event.target instanceof Element) event.target.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!down?.draw) return;
      if (!drawing.value && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= clickSlop) return;
      drawing.value = boxFrom(down, event);
    };
    const release = (event: PointerEvent) => {
      const start = down;
      const drawn = drawing.value;
      down = null;
      drawing.value = null;
      if (!start) return;
      if (drawn) {
        const box = boxFrom(start, event);
        const element = box.width >= minimumArea && box.height >= minimumArea ? containerOf(box) : undefined;
        if (!element) return;
        event.preventDefault();
        try {
          state.startDraft(element, { area: box, point: { x: box.left, y: box.top } });
        } catch {
          // The area is outside the page.
        }
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > clickSlop) return;
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
          const pin = [...pins].find((pin) => pin.getAttribute("data-thread-id") === target);
          (pin ?? layer.value?.querySelector<HTMLElement>("[data-slot='comment-toolbar-mode']"))?.focus();
          restoring = false;
        });
      },
      { flush: "post" },
    );
    // A new comment takes the focus. When it is sent or discarded, the focus goes back to the element of the page that
    // had it, such as the element that Enter commented on in comment mode.
    let draftReturn: HTMLElement | null = null;
    watch(
      () => state.draft.value,
      (next, previous) => {
        if (next && !previous) {
          const active = document.activeElement;
          const root = uiRoot();
          draftReturn = active instanceof HTMLElement && active !== document.body && !(root instanceof ShadowRoot && active === root.host) && !layer.value?.contains(active) ? active : null;
          return;
        }
        if (next || !previous) return;
        const target = draftReturn;
        draftReturn = null;
        void nextTick(() => {
          const focused = uiRoot().activeElement;
          // Only when the focus was lost with the composer, not when the person already went elsewhere.
          if (target?.isConnected && (!focused || focused === document.body)) target.focus({ preventScroll: true });
        });
      },
      { flush: "sync" },
    );
    // The height of a new comment's bubble, with its gap to the box under it.
    const draftAboveRoom = 72;
    // `--vh-comment-x` lets the card move back on screen when the screen is narrower than the card.
    const place = ({ x, y }: { x: number; y: number }) => ({ left: `${x}px`, top: `${y}px`, "--vh-comment-x": `${x}px` });
    const side = (x: number, y: number) => ({
      "data-flip-x": x + popoverWidth > window.innerWidth ? "true" : undefined,
      "data-flip-y": y + popoverHeight > window.innerHeight ? "true" : undefined,
    });

    // The thread tracks each action itself: it clears a box only after the handler succeeded, and shows a failure.
    const threadView = (thread: CommentThreadModel) =>
      h(CommentThread, {
        accept: props.accept,
        attachmentUrl: props.attachmentUrl,
        attachments: attachmentsOn.value,
        can: props.can,
        key: thread.id,
        detached: state.positions.value.get(thread.id)?.detached === true,
        readOnly: props.readOnly,
        onClose: () => state.close(),
        onDelete: (messageId: string) => state.remove(thread.id, messageId),
        onEdit: (messageId: string, body: string, mentions: string[]) => state.edit(thread.id, messageId, body, mentions),
        onReopen: () => state.reopen(thread.id),
        onReply: async (body: string, mentions: string[], files: File[]) => state.reply(thread.id, body, mentions, await keys(files)),
        // Resolving puts the thread away, as in Figma.
        onResolve: async () => {
          await state.resolve(thread.id);
          state.close();
        },
        thread,
        user: user.value,
      });

    return () => {
      // Pins that would cover each other, such as two quotes of one paragraph in its gutter, stack downward, so each
      // stays visible and takes its own click.
      const spots = new Map<string, AnchorPosition>();
      for (const thread of pinned.value) {
        const position = state.positions.value.get(thread.id);
        if (!position || position.detached || position.clipped || thread.anchor.kind === "page") continue;
        let y = position.y;
        while ([...spots.values()].some((spot) => Math.abs(spot.x - position.x) < pinSpacing && Math.abs(spot.y - y) < pinSpacing)) y += pinSpacing;
        spots.set(thread.id, { ...position, y });
      }
      const items = pinned.value.flatMap((thread) => {
        const position = spots.get(thread.id);
        if (!position) return [];
        const open = state.openId.value === thread.id;
        const hover = state.hoverId.value === thread.id && !open && !state.draft.value;
        return [
          h(
            "div",
            {
              ...side(position.x, position.y),
              "data-kind": thread.anchor.kind,
              "data-slot": "comment-layer-item",
              key: thread.id,
              style: place(position),
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
              hover
                ? h("div", { "data-preview": "true", "data-slot": "comment-layer-popover" }, h(CommentThread, { preview: true, thread }))
                : null,
            ],
          ),
        ];
      });

      // Keep one thread instance while its anchor moves between pinned and floating positions.
      const opened = state.opened.value;
      const openedPosition = opened && state.positions.value.get(opened.id);
      const pointForThread = openedPosition && !openedPosition.detached && !openedPosition.clipped && opened?.anchor.kind !== "page" ? (spots.get(opened.id) ?? openedPosition) : undefined;
      const openThread = opened
        ? h("div", {
            ...(pointForThread ? side(pointForThread.x, pointForThread.y) : {}),
            "data-kind": opened.anchor.kind,
            "data-slot": "comment-layer-item",
            key: "opened-thread",
            style: pointForThread ? place(pointForThread) : undefined,
          }, h("div", { "data-floating": pointForThread ? undefined : "true", "data-slot": "comment-layer-popover" }, threadView(opened)))
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
                // A new comment on an area opens above it, so the box stays in view while the person types.
                ...(draft.anchor.kind === "area" || draft.anchor.kind === "image") && point.y > draftAboveRoom ? { "data-above": "true" } : {},
                "data-draft": "true",
                "data-kind": draft.anchor.kind,
                "data-slot": "comment-layer-item",
                style: place(point),
              },
              [
                h(CommentPin, { author: user.value, draft: true }),
                h(
                  "div",
                  { "data-slot": "comment-layer-popover" },
                  h(CommentComposer, {
                    accept: props.accept,
                    attachments: attachmentsOn.value,
                    busy: draft.busy || uploadingDraft.value === draft,
                    error: draft.error,
                    mentions: draft.mentions,
                    modelValue: draft.body,
                    onCancel: () => state.cancelDraft(),
                    files: draftFiles.value,
                    onSubmit: async (submit: CommentComposerSubmit) => {
                      if (draft.busy || uploadingDraft.value === draft || state.draft.value !== draft) return;
                      uploadingDraft.value = draft;
                      draft.error = undefined;
                      draft.mentions = submit.mentions;
                      const submitted = draftFiles.value;
                      const body = draft.body;
                      const mentions = draft.mentions;
                      try {
                        const attachments = await keys(submit.files);
                        // The box stays editable during an upload. A changed draft is not what was sent, so it waits for another Enter.
                        if (state.draft.value !== draft || draft.body !== body || draft.mentions !== mentions || draftFiles.value !== submitted) return;
                        draft.attachments = attachments;
                        if (await state.send() && draftFiles.value === submitted) draftFiles.value = [];
                      } catch (error) {
                        draft.error = error instanceof Error ? error.message : "The files could not be uploaded. Try again.";
                      } finally {
                        if (uploadingDraft.value === draft) uploadingDraft.value = null;
                      }
                    },
                    "onUpdate:files": (value: File[]) => (draftFiles.value = value),
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
                onPointercancel: () => {
                  down = null;
                  drawing.value = null;
                },
                onPointerdown: press,
                onPointermove: move,
                onPointerup: release,
              }, drawing.value
                ? [h("div", {
                    "data-slot": "comment-layer-area",
                    style: { left: `${drawing.value.left}px`, top: `${drawing.value.top}px`, width: `${drawing.value.width}px`, height: `${drawing.value.height}px` },
                  })]
                : [])
            : null,
          ...items,
          composing,
          openThread,
          slots.default?.({ comments: state }) ?? [
            h(CommentToolbar, { comments: state, people: props.people }),
            state.listOpen.value ? h(CommentList, { comments: state, navigate: props.navigate }) : null,
          ],
        ],
      );
    };
  },
});
