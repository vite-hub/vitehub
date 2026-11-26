import type { AnchorPoint, CommentsClient, ResolvedAnchor, CommentSubject, CommentThread as CommentThreadModel, CommentUser } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, onUpdated, type PropType, reactive, ref, shallowRef, watch } from "vue";
import { type CommentCan, draftPositionKey, provideComments, useComments, type CommentDraft, type CommentsState } from "../headless/comments.ts";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { useCommentAttachments } from "../internal/comment-attachments.ts";
import { consumedPointerEvents } from "../internal/comment-outside.ts";
import { excerpt } from "../internal/comment-person.ts";
import { threadRow } from "../internal/comment-row.ts";
import { commentThreadKey } from "../internal/comment-selection.ts";
import { commentTitle, deliveryAttributes } from "../internal/comment-status.ts";
import { createMotionList, type MotionList } from "../motion/list.ts";
import type { AvatarStackPerson } from "./avatar-stack.ts";
import { CommentComposer, type CommentComposerSize, type CommentComposerSubmit } from "./comment-composer.ts";
import { CommentList, CommentToolbar } from "./comment-list.ts";
import { CommentPin } from "./comment-pin.ts";
import type { CommentUpload } from "./comment-panel.ts";
import { type CommentAttachmentUrl, CommentThread } from "./comment-thread.ts";

const popoverWidth = 360;
const popoverHeight = 420;

function placeDraft(point: AnchorPoint, page: boolean, width: number, viewport: number) {
  const rem = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
  const inset = rem / 2;
  const x = page ? (viewport - width) / 2 - inset : point.x;
  const flipX = x > viewport / 2 && x + inset + width > viewport - inset;
  const left = Math.max(inset, Math.min(flipX ? x - inset - width : x + inset, viewport - inset - width));
  return { x, y: point.y, flipX, left: left - x };
}

const pinShape = (kind: CommentThreadModel["anchor"]["kind"]) => (kind === "area" || kind === "image" ? "round" : "point");

const clickSlop = 6;
const pinSpacing = 32;
const minimumArea = 8;
const marginMinWidth = 900;
const marginGap = 8;
const marginCardHeight = 72;

/** Where a thread opens: in a card beside its pin, or in a column of cards on the right edge of the screen. */
export type CommentPlacement = "pin" | "margin";

type Box = { left: number; top: number; width: number; height: number };

function containerOf(box: Box): Element | undefined {
  const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const under = document.elementsFromPoint(center.x, center.y).find((element) => !element.closest("[data-comments-ui]") && !element.localName.startsWith("vitehub-") && element !== document.documentElement);
  for (let element: Element | null = under ?? null; element && element !== document.documentElement; element = element.parentElement) {
    const rect = element.getBoundingClientRect();
    if (rect.left <= box.left + 1 && rect.top <= box.top + 1 && rect.right >= box.left + box.width - 1 && rect.bottom >= box.top + box.height - 1) return element;
  }
  return undefined;
}

export const CommentLayer = defineComponent({
  name: "CommentLayer",
  props: {
    client: { type: Object as PropType<CommentsClient> },
    subject: { type: Object as PropType<CommentSubject> },
    user: { type: Object as PropType<CommentUser> },
    comments: { type: Object as PropType<CommentsState> },
    people: { default: () => [], type: Array as PropType<AvatarStackPerson[]> },
    hotkey: { default: "c", type: [String, Boolean] as PropType<string | false> },
    readOnly: { default: false, type: Boolean },
    subjectUrl: { type: Function as PropType<(subject: CommentSubject) => string | undefined> },
    navigate: { type: Function as PropType<(href: string) => void> },
    can: { type: Function as PropType<CommentCan> },
    upload: { type: Function as PropType<CommentUpload> },
    queueFiles: { default: false, type: Boolean },
    accept: { type: String },
    attachmentUrl: { type: Function as PropType<CommentAttachmentUrl> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    placement: { default: "pin", type: String as PropType<CommentPlacement> },
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
    watch(() => state.draft.value, (next, previous) => {
      if (next !== previous) draftFiles.value = next?.files ? [...next.files] : [];
    });
    const { enabled: attachmentsOn, prepare, queued } = useCommentAttachments(state, props);

    const user = computed(() => state.user.value);
    const pinned = computed(() => state.threads.value.filter(thread =>
      state.pageThreads.value.includes(thread) || state.shown.value.has(thread.id) || state.leaving.value.has(thread.id),
    ));
    const drawn = computed(() => pinned.value.filter((thread) => state.shown.value.has(thread.id) || state.leaving.value.has(thread.id)));

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
        } catch {}
        return;
      }
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > clickSlop) return;
      event.preventDefault();
      try {
        state.startDraft({ x: event.clientX, y: event.clientY });
      } catch {}
    };

    let returnTo: string | null = null;
    let restoring = false;
    watch(() => state.opened.value && commentThreadKey(state.opened.value), key => {
      if (key) void nextTick(() => layer.value?.querySelector<HTMLElement>("[data-slot='comment-thread']:not([data-preview])")?.focus());
    });
    watch(
      () => state.openId.value,
      (id, previous) => {
        if (id) return;
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
          restoring = true;
          const pin = [...pins].find((pin) => pin.getAttribute("data-thread-id") === target);
          (pin ?? layer.value?.querySelector<HTMLElement>("[data-slot='comment-toolbar-mode']"))?.focus();
          restoring = false;
        });
      },
      { flush: "post" },
    );
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
          if (target?.isConnected && (!focused || focused === document.body)) target.focus({ preventScroll: true });
        });
      },
      { flush: "sync" },
    );
    const draftAboveRoom = 72;
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
    const place = ({ x, y }: { x: number; y: number }) => ({ left: `${x}px`, top: `${y}px`, "--vh-comment-x": `${x}px` });
    const picked = reactive(new Map<string, { x: boolean; y: boolean }>());
    const placedItems = new Map<string, HTMLElement>();
    const observedCards = new Map<string, HTMLElement>();
    const observeCard = (key: string, card: HTMLElement | null) => {
      const previous = observedCards.get(key);
      if (previous === card) return;
      if (previous) cardSizes?.unobserve(previous);
      observedCards.delete(key);
      if (card) {
        observedCards.set(key, card);
        cardSizes?.observe(card);
      }
    };
    const readSides = () => {
      for (const [key, item] of placedItems) {
        const card = item.querySelector<HTMLElement>(":scope > [data-slot='comment-layer-popover']");
        const area = card ? getComputedStyle(card).getPropertyValue("position-area") : "";
        observeCard(key, card && area && area !== "none" ? card : null);
        if (!card || !area || area === "none") {
          picked.delete(key);
          continue;
        }
        const spot = item.getBoundingClientRect();
        const box = card.getBoundingClientRect();
        const next = { x: box.left + box.right < spot.left * 2, y: box.top + box.bottom < spot.top * 2 };
        const now = picked.get(key);
        if (now?.x !== next.x || now?.y !== next.y) picked.set(key, next);
      }
    };
    const cardSizes = typeof ResizeObserver === "function" ? new ResizeObserver(readSides) : undefined;
    let sideFrame = 0;
    const readSidesSoon = () => {
      if (!sideFrame) sideFrame = requestAnimationFrame(() => {
        sideFrame = 0;
        readSides();
      });
    };
    onMounted(() => {
      readSides();
      window.addEventListener("resize", readSidesSoon, { passive: true });
      window.visualViewport?.addEventListener("resize", readSidesSoon, { passive: true });
    });
    let marginList: MotionList | undefined;
    const moveMargin = () => {
      const element = layer.value;
      if (!element) return;
      if (marginList) marginList.play();
      else marginList = createMotionList(element, { items: (root) => [...root.querySelectorAll<HTMLElement>("[data-margin-key]")], movesOnly: true });
      marginList.measure();
    };
    onMounted(moveMargin);
    onUpdated(() => {
      readSides();
      moveMargin();
    });
    onBeforeUnmount(() => {
      marginList?.destroy();
      cardSizes?.disconnect();
      cancelAnimationFrame(sideFrame);
      window.removeEventListener("resize", readSidesSoon);
      window.visualViewport?.removeEventListener("resize", readSidesSoon);
    });
    const placedItem = (key: string) => (element: unknown) => {
      if (element instanceof HTMLElement) placedItems.set(key, element);
      else {
        placedItems.delete(key);
        observeCard(key, null);
        picked.delete(key);
      }
    };
    const side = (x: number, y: number, key?: string) => {
      const seen = key === undefined ? undefined : picked.get(key);
      const flipX = seen ? seen.x : x + popoverWidth > window.innerWidth;
      const flipY = seen ? seen.y : y + popoverHeight > window.innerHeight;
      return { "data-flip-x": flipX ? "true" : undefined, "data-flip-y": flipY ? "true" : undefined };
    };

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
        frame: "none",
        layout: "row",
        onSubmit: async (submit: CommentComposerSubmit) => {
          if (draft.busy || uploadingDraft.value === draft || state.draft.value !== draft) return;
          draft.error = undefined;
          draft.mentions = submit.mentions;
          const files = queued(submit.files);
          if (files) {
            draft.attachments = [];
            await state.send({ files });
            return;
          }
          uploadingDraft.value = draft;
          const submitted = draftFiles.value;
          const body = draft.body;
          const mentions = draft.mentions;
          try {
            const { attachments, files } = await prepare(submit.files);
            if (state.draft.value !== draft || draft.body !== body || draft.mentions !== mentions || draftFiles.value !== submitted) return;
            draft.attachments = attachments;
            if (await state.send({ files }) && draftFiles.value === submitted) draftFiles.value = [];
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
        size: props.size,
        user: user.value,
        users: state.users,
      });

    const screenWidth = ref(0);
    const onResize = () => {
      screenWidth.value = window.innerWidth;
      measureDraft();
    };
    onMounted(() => {
      screenWidth.value = window.innerWidth;
      window.addEventListener("resize", onResize, { passive: true });
    });
    onBeforeUnmount(() => window.removeEventListener("resize", onResize));
    const inMargin = computed(() => props.placement === "margin" && screenWidth.value >= marginMinWidth);
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

    const statusSlot = () => (slots.status ? { status: slots.status } : undefined);
    const threadView = (thread: CommentThreadModel) =>
      h(CommentThread, {
        accept: props.accept,
        attachmentUrl: props.attachmentUrl,
        attachments: attachmentsOn.value,
        can: props.can,
        key: commentThreadKey(thread),
        detached: state.positions.value.get(thread.id)?.detached === true,
        readOnly: props.readOnly,
        size: props.size,
        onClose: () => state.close(),
        onDelete: (messageId: string) => state.remove(thread.id, messageId),
        onEdit: (messageId: string, body: string, mentions: string[]) => state.edit(thread.id, messageId, body, mentions),
        onReopen: () => state.reopen(thread.id),
        onReply: async (body: string, mentions: string[], list: File[]) => {
          const { attachments, files } = await prepare(list);
          return state.reply(thread.id, body, mentions, attachments, files);
        },
        onResolve: async () => {
          await state.resolve(thread.id);
          state.close();
        },
        thread,
        user: user.value,
      }, statusSlot());

    const marginLayout = (spots: Map<string, ResolvedAnchor>, draftY?: number) => {
      type Entry = { key: string; y: number; thread?: CommentThreadModel; active: boolean };
      const entries: Entry[] = pinned.value.flatMap((thread) => {
        const spot = state.shown.value.has(thread.id) ? spots.get(thread.id) : undefined;
        return spot ? [{ active: state.openId.value === thread.id, key: thread.id, thread, y: spot.y }] : [];
      });
      if (draftY !== undefined) entries.push({ active: true, key: draftPositionKey, y: draftY });
      entries.sort((a, b) => a.y - b.y);
      const height = (entry: Entry) => cardHeights.get(entry.key) ?? (entry.active ? popoverHeight : marginCardHeight);
      const tops: number[] = [];
      let below = -Infinity;
      for (const entry of entries) {
        const top = Math.max(entry.y - 16, below + marginGap);
        tops.push(top);
        below = top + height(entry);
      }
      const edge = window.innerHeight - marginGap * 2;
      entries.forEach((entry, index) => {
        if (!entry.active || tops[index]! + height(entry) <= edge) return;
        tops[index] = Math.max(marginGap * 2, edge - height(entry));
        for (let before = index - 1; before >= 0; before--) tops[before] = Math.min(tops[before]!, tops[before + 1]! - marginGap - height(entries[before]!));
        for (let after = index + 1; after < entries.length; after++) tops[after] = Math.max(tops[after]!, tops[after - 1]! + marginGap + height(entries[after - 1]!));
      });
      const at = new Map(entries.map((entry, index) => [entry.key, tops[index]!]));
      const cards = entries.flatMap((entry, index) => {
        const thread = entry.thread;
        if (!thread || entry.active) return [];
        return [h(
          "button",
          {
            "aria-label": `${commentTitle(thread)}: ${excerpt(thread.messages[0]?.body ?? "")}`,
            "data-margin-key": entry.key,
            "data-slot": "comment-margin-card",
            "data-status": thread.status,
            ...deliveryAttributes(thread.delivery),
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
      const spots = new Map<string, ResolvedAnchor>();
      for (const thread of drawn.value) {
        const position = state.positions.value.get(thread.id);
        if (!position || position.detached || position.clipped || thread.anchor.kind === "page") continue;
        const taken = (y: number) => [...spots.values()].some((spot) => Math.abs(spot.x - position.x) < pinSpacing && Math.abs(spot.y - y) < pinSpacing);
        let y = position.y;
        while (taken(y)) y += pinSpacing;
        if (y !== position.y && y > window.innerHeight - pinSpacing) {
          y = position.y - pinSpacing;
          while (taken(y)) y -= pinSpacing;
        }
        spots.set(thread.id, { ...position, y });
      }
      const items = drawn.value.flatMap((thread) => {
        const position = spots.get(thread.id);
        if (!position) return [];
        const leaving = !state.shown.value.has(thread.id);
        const open = state.openId.value === thread.id;
        const hover = state.hoverId.value === thread.id && !leaving && !open && !state.draft.value && !inMargin.value;
        return [
          h(
            "div",
            {
              ...side(position.x, position.y, thread.id),
              "data-kind": thread.anchor.kind,
              "data-leaving": leaving ? "true" : undefined,
              "data-slot": "comment-layer-item",
              inert: leaving || undefined,
              key: thread.id,
              ref: placedItem(thread.id),
              style: place(position),
            },
            [
              h(CommentPin, {
                active: open,
                author: thread.author,
                "data-shape": pinShape(thread.anchor.kind),
                "data-thread-id": thread.id,
                ...deliveryAttributes(thread.delivery),
                excerpt: excerpt(thread.messages[0]?.body ?? ""),
                ...(thread.n ? { n: thread.n } : {}),
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
                ? h("div", { "data-preview": "true", "data-slot": "comment-layer-popover" }, h(CommentThread, { preview: true, size: props.size, thread }, statusSlot()))
                : null,
            ],
          ),
        ];
      });

      const draft = state.draft.value;
      const draftPosition = draft && state.positions.value.get(draftPositionKey);
      const point = draftPosition && !draftPosition.detached && draft?.anchor.kind !== "page" ? draftPosition : draft?.point;
      const draftInMargin = Boolean(inMargin.value && draft && point && draft.anchor.kind !== "page");
      const margin = inMargin.value ? marginLayout(spots, draftInMargin ? point!.y : undefined) : null;
      const inColumn = (key: string) => {
        const top = margin?.at.get(key);
        return top === undefined ? undefined : { "data-margin": "true", "data-margin-key": key, style: { top: `${top}px` } };
      };

      const opened = state.opened.value;
      const openedPosition = opened && state.positions.value.get(opened.id);
      const pointForThread = openedPosition && !openedPosition.detached && !openedPosition.clipped && opened?.anchor.kind !== "page" ? (spots.get(opened.id) ?? openedPosition) : undefined;
      const openedColumn = opened && pointForThread ? inColumn(opened.id) : undefined;
      const openThread = opened
        ? h("div", {
            ...(pointForThread ? side(pointForThread.x, pointForThread.y, "opened-thread") : {}),
            "data-kind": opened.anchor.kind,
            "data-slot": "comment-layer-item",
            key: "opened-thread",
            ref: placedItem("opened-thread"),
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
                ...(draft.anchor.kind === "area" || draft.anchor.kind === "image") && placement.y > draftAboveRoom && !draftBelow.value ? { "data-above": "true" } : {},
                "data-draft": "true",
                "data-kind": draft.anchor.kind,
                "data-slot": "comment-layer-item",
                style: place(placement),
              },
              [
                h(CommentPin, { author: user.value, "data-shape": pinShape(draft.anchor.kind), draft: true }),
                h(
                  "div",
                  {
                    ...draftColumn,
                    "data-motion-appear": draftColumn ? undefined : "[data-slot=comment-pin]",
                    "data-slot": "comment-layer-popover",
                    style: draftColumn?.style ?? { "--vh-comment-draft-left": `${placement.left}px` },
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
