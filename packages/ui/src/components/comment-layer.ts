import type { AnchorPoint, CommentsClient, ResolvedAnchor, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, type PropType, reactive, ref, shallowRef, watch } from "vue";
import { type CommentCan, draftPositionKey, provideComments, useComments, type CommentDraft, type CommentsState } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { consumedPointerEvents } from "../internal/comment-outside.ts";
import { excerpt } from "../internal/comment-person.ts";
import { threadRow } from "../internal/comment-row.ts";
import type { AvatarStackPerson } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSize, type CommentComposerSubmit } from "./comment-composer.ts";
import { CommentList, CommentToolbar } from "./comment-list.ts";
import { CommentPin } from "./comment-pin.ts";
import type { CommentUpload } from "./comment-panel.ts";
import { type CommentAttachmentUrl, CommentThread } from "./comment-thread.ts";

const popoverWidth = 360;
const popoverHeight = 420;

// CSS owns the bubble width. Measure its unscaled box so overlay styles and the entrance animation cannot change placement.
function placeDraft(point: AnchorPoint, page: boolean, width: number, viewport: number) {
  const rem = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  const inset = rem / 2;
  const x = page ? (viewport - width) / 2 - inset : point.x;
  // If neither side fits, use the side with more room and shift only the bubble, leaving the pin on its spot.
  const flipX = x > viewport / 2 && x + inset + width > viewport - inset;
  const left = Math.max(inset, Math.min(flipX ? x - inset - width : x + inset, viewport - inset - width));
  return { x, y: point.y, flipX, left: left - x };
}

// A pointer that moved more than this between down and up was a scroll or a drag, not a click.
const clickSlop = 6;
// The room of one pin. Pins closer than this to each other stack.
const pinSpacing = 32;
// A drag in comment mode draws an area. A smaller one is a slip, not an area.
const minimumArea = 8;
// Margin placement needs this much screen. A narrower one puts each thread beside its pin.
const marginMinWidth = 900;
// The room between two cards in the margin, and the height a card takes until it is measured.
const marginGap = 8;
const marginCardHeight = 72;

/** Where a thread opens: in a card beside its pin, or in a column of cards on the right edge of the screen. */
export type CommentPlacement = "pin" | "margin";

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
    /**
     * Where threads open. `"pin"` opens a thread in a card beside its pin. `"margin"` shows every thread as a card in a
     * column on the right edge of the screen, level with its pin, and opens it in that card, with the reply box there.
     * A new comment is written there too. On a screen narrower than 900px, `"margin"` works as `"pin"`.
     */
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    placement: { default: "pin", type: String as PropType<CommentPlacement> },
    /**
     * The size of the thread cards. `"sm"`, the default, is Drop's floating card: 14px text, tight rows, and Edit and
     * Delete over the name's row. `"md"` is the size of a thread in a panel.
     */
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    size: { default: "sm", type: String as PropType<CommentComposerSize> },
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
    // The files belong to one draft. A new draft starts with its own, such as a screenshot, or none.
    watch(() => state.draft.value, (next, previous) => {
      if (next !== previous) draftFiles.value = next?.files ? [...next.files] : [];
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
    // The card of a new comment grows with its text. When a card above its area reaches the top of the screen, it opens
    // under the area instead, until the next draft.
    const draftCard = ref<HTMLElement | null>(null);
    const draftBelow = ref(false);
    const draftWidth = ref(0);
    const measureDraft = () => { draftWidth.value = draftCard.value?.offsetWidth ?? 0; };
    watch(() => state.draft.value, (next, previous) => {
      if (next !== previous) draftBelow.value = false;
    });
    const fits = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          measureDraft();
          const card = draftCard.value;
          if (card?.parentElement?.hasAttribute("data-above") && card.getBoundingClientRect().top < 8) draftBelow.value = true;
        })
      : undefined;
    watch(draftCard, (card, previous) => {
      if (previous) fits?.unobserve(previous);
      if (card) fits?.observe(card);
      measureDraft();
    });
    onBeforeUnmount(() => fits?.disconnect());
    // `--vh-comment-x` lets the card move back on screen when the screen is narrower than the card.
    const place = ({ x, y }: { x: number; y: number }) => ({ left: `${x}px`, top: `${y}px`, "--vh-comment-x": `${x}px` });
    const side = (x: number, y: number) => ({
      "data-flip-x": x + popoverWidth > window.innerWidth ? "true" : undefined,
      "data-flip-y": y + popoverHeight > window.innerHeight ? "true" : undefined,
    });

    // The box of a new comment: beside its pin, or in the margin.
    const composerView = (draft: CommentDraft) =>
      h(CommentComposer, {
        accept: props.accept,
        attachments: attachmentsOn.value,
        busy: draft.busy || uploadingDraft.value === draft,
        error: draft.error,
        mentions: draft.mentions,
        modelValue: draft.body,
        onCancel: () => state.cancelDraft(),
        files: draftFiles.value,
        layout: "row",
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
      });

    // Margin placement: the width of the screen decides whether there is room for it.
    const screenWidth = ref(typeof window === "undefined" ? 0 : window.innerWidth);
    const onResize = () => {
      screenWidth.value = window.innerWidth;
      measureDraft();
    };
    onMounted(() => window.addEventListener("resize", onResize, { passive: true }));
    onBeforeUnmount(() => window.removeEventListener("resize", onResize));
    const inMargin = computed(() => props.placement === "margin" && screenWidth.value >= marginMinWidth);
    // Each card in the margin is measured, so the cards under it move down when it grows, such as when it opens.
    const cardHeights = reactive(new Map<string, number>());
    const cards = new Map<string, Element>();
    const measure = typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            const key = entry.target.getAttribute("data-margin-key");
            const height = Math.round(entry.target.getBoundingClientRect().height);
            if (key && height && cardHeights.get(key) !== height) cardHeights.set(key, height);
          }
        })
      : undefined;
    onBeforeUnmount(() => measure?.disconnect());
    const measured = (key: string) => (element: unknown) => {
      const before = cards.get(key);
      if (before && before !== element) measure?.unobserve(before);
      if (element instanceof Element) {
        cards.set(key, element);
        measure?.observe(element);
      } else cards.delete(key);
    };

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
        size: props.size,
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

    // The margin: where each card goes, level with its pin and below the card above it. The open thread and the new
    // comment's box take their place in the column too, but stay inside the screen, so their reply box is never below it.
    const marginLayout = (spots: Map<string, ResolvedAnchor>, draftY?: number) => {
      type Entry = { key: string; y: number; thread?: CommentThreadModel; active: boolean };
      const entries: Entry[] = pinned.value.flatMap((thread) => {
        const spot = spots.get(thread.id);
        return spot ? [{ active: state.openId.value === thread.id, key: thread.id, thread, y: spot.y }] : [];
      });
      if (draftY !== undefined) entries.push({ active: true, key: draftPositionKey, y: draftY });
      entries.sort((a, b) => a.y - b.y);
      const height = (entry: Entry) => cardHeights.get(entry.key) ?? (entry.active ? popoverHeight : marginCardHeight);
      const tops: number[] = [];
      let below = -Infinity;
      for (const entry of entries) {
        // Level with the pin's tip, which is the spot, and never over the card above.
        const top = Math.max(entry.y - 16, below + marginGap);
        tops.push(top);
        below = top + height(entry);
      }
      // An open card that would end below the screen moves up into it, and the cards above it move up to make room.
      const edge = window.innerHeight - marginGap * 2;
      entries.forEach((entry, index) => {
        if (!entry.active || tops[index]! + height(entry) <= edge) return;
        tops[index] = Math.max(marginGap * 2, edge - height(entry));
        for (let before = index - 1; before >= 0; before--) tops[before] = Math.min(tops[before]!, tops[before + 1]! - marginGap - height(entries[before]!));
        for (let after = index + 1; after < entries.length; after++) tops[after] = Math.max(tops[after]!, tops[after - 1]! + marginGap + height(entries[after - 1]!));
      });
      const at = new Map(entries.map((entry, index) => [entry.key, tops[index]!]));
      // The compact cards. The open thread and the new comment's box are drawn by the layer itself, so they keep their
      // text when the placement changes.
      const cards = entries.flatMap((entry, index) => {
        const thread = entry.thread;
        if (!thread || entry.active) return [];
        return [h(
          "button",
          {
            "aria-label": `Comment ${thread.n}: ${excerpt(thread.messages[0]?.body ?? "")}`,
            "data-margin-key": entry.key,
            "data-slot": "comment-margin-card",
            "data-status": thread.status,
            key: entry.key,
            onClick: () => state.open(thread),
            onPointerenter: () => {
              if (!state.draft.value) state.hoverId.value = thread.id;
            },
            onPointerleave: () => {
              if (state.hoverId.value === thread.id) state.hoverId.value = null;
            },
            ref: measured(entry.key),
            style: { top: `${tops[index]}px` },
            type: "button",
          },
          threadRow(thread),
        )];
      });
      return { at, node: h("div", { "data-slot": "comment-margin" }, cards) };
    };

    return () => {
      // Pins that would cover each other, such as two quotes of one paragraph in its gutter, stack downward, or upward
      // at the bottom of the screen, so each stays visible and takes its own click.
      const spots = new Map<string, ResolvedAnchor>();
      for (const thread of pinned.value) {
        const position = state.positions.value.get(thread.id);
        if (!position || position.detached || position.clipped || thread.anchor.kind === "page") continue;
        const taken = (y: number) => [...spots.values()].some((spot) => Math.abs(spot.x - position.x) < pinSpacing && Math.abs(spot.y - y) < pinSpacing);
        let y = position.y;
        while (taken(y)) y += pinSpacing;
        // Without room under the screen's bottom edge, the stack grows upward.
        if (y !== position.y && y > window.innerHeight - pinSpacing) {
          y = position.y - pinSpacing;
          while (taken(y)) y -= pinSpacing;
        }
        spots.set(thread.id, { ...position, y });
      }
      const items = pinned.value.flatMap((thread) => {
        const position = spots.get(thread.id);
        if (!position) return [];
        const open = state.openId.value === thread.id;
        const hover = state.hoverId.value === thread.id && !open && !state.draft.value && !inMargin.value;
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
                ? h("div", { "data-preview": "true", "data-slot": "comment-layer-popover" }, h(CommentThread, { preview: true, size: props.size, thread }))
                : null,
            ],
          ),
        ];
      });

      const draft = state.draft.value;
      const draftPosition = draft && state.positions.value.get(draftPositionKey);
      // A comment on the whole page has no spot. Keep its opening height and center its bubble.
      const point = draftPosition && !draftPosition.detached && draft?.anchor.kind !== "page" ? draftPosition : draft?.point;
      const draftInMargin = Boolean(inMargin.value && draft && point && draft.anchor.kind !== "page");
      const margin = inMargin.value ? marginLayout(spots, draftInMargin ? point!.y : undefined) : null;
      // In the margin, a card is fixed to the right edge of the screen at its top from the layout, and measured.
      const inColumn = (key: string) => {
        const top = margin?.at.get(key);
        return top === undefined ? undefined : { "data-margin": "true", "data-margin-key": key, style: { top: `${top}px` } };
      };

      // Keep one thread instance while its anchor moves between pinned and floating positions, and into the margin.
      const opened = state.opened.value;
      const openedPosition = opened && state.positions.value.get(opened.id);
      const pointForThread = openedPosition && !openedPosition.detached && !openedPosition.clipped && opened?.anchor.kind !== "page" ? (spots.get(opened.id) ?? openedPosition) : undefined;
      const openedColumn = opened && pointForThread ? inColumn(opened.id) : undefined;
      const openThread = opened
        ? h("div", {
            ...(pointForThread ? side(pointForThread.x, pointForThread.y) : {}),
            "data-kind": opened.anchor.kind,
            "data-slot": "comment-layer-item",
            key: "opened-thread",
            style: pointForThread ? place(pointForThread) : undefined,
          }, h("div", {
            ...openedColumn,
            "data-floating": pointForThread ? undefined : "true",
            "data-slot": "comment-layer-popover",
            ref: (element: unknown) => openedColumn && measured(opened.id)(element),
          }, threadView(opened)))
        : null;

      const placement = draft && point ? placeDraft(point, draft.anchor.kind === "page", draftWidth.value, screenWidth.value) : undefined;
      const draftColumn = draftInMargin ? inColumn(draftPositionKey) : undefined;
      const composing =
        draft && placement
          ? h(
              "div",
              {
                ...side(placement.x, placement.y),
                "data-flip-x": placement.flipX ? "true" : undefined,
                // A new comment on an area opens above it, so the box stays in view while the person types.
                ...(draft.anchor.kind === "area" || draft.anchor.kind === "image") && placement.y > draftAboveRoom && !draftBelow.value ? { "data-above": "true" } : {},
                "data-draft": "true",
                "data-kind": draft.anchor.kind,
                "data-slot": "comment-layer-item",
                style: place(placement),
              },
              [
                h(CommentPin, { author: user.value, draft: true }),
                h(
                  "div",
                  {
                    ...draftColumn,
                    "data-slot": "comment-layer-popover",
                    style: draftColumn?.style ?? { left: `${placement.left}px`, right: "auto" },
                    ref: (element: unknown) => {
                      draftCard.value = element instanceof HTMLElement ? element : null;
                      if (draftColumn) measured(draftPositionKey)(element);
                    },
                  },
                  composerView(draft),
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
                  }, [
                    // Its corners and its size, while the drag lasts.
                    ...["top-left", "top-right", "bottom-left", "bottom-right"].map((corner) => h("span", { "data-corner": corner, "data-slot": "comment-layer-area-handle", key: corner })),
                    h("span", { "data-slot": "comment-layer-area-size" }, `${Math.round(drawing.value.width)} × ${Math.round(drawing.value.height)}`),
                  ])]
                : [])
            : null,
          ...items,
          composing,
          openThread,
          margin?.node,
          slots.default?.({ comments: state }) ?? [
            h(CommentToolbar, { comments: state, people: props.people }),
            state.listOpen.value ? h(CommentList, { comments: state, navigate: props.navigate }) : null,
          ],
        ],
      );
    };
  },
});
