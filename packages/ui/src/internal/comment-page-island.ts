import type { CommentThread } from "@vite-hub/comments/client";
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, type PropType, provide, ref, type Ref, type SlotsType, type VNode, watch } from "vue";
import type { AvatarStackPerson } from "../components/avatar-stack.ts";
import { AvatarStack } from "../components/avatar-stack.ts";
import { useViteHubUIIcons } from "../config.ts";
import type { CommentDraft, CommentsState } from "../headless/comments.ts";
import { prefersReducedMotion } from "../motion/reduced-motion.ts";
import { commentThreadPortals, consumedPointerEvents, hasDirtyComposer, pathOf, shakeDirtyComposers, swallowNextClick, useDocumentPointerDown } from "./comment-outside.ts";
import { writerPerson } from "./comment-person.ts";
import { threadRow } from "./comment-row.ts";
import { useUIComponent } from "./nuxt-ui.ts";

/** What the whole-page island shows: nothing, the open whole-page threads, those and a call to comment, or its card. */
export type CommentPageIslandState = "none" | "count" | "hint" | "open";

/** The scope of the island's `composer` slot. */
export interface CommentPageIslandComposerScope {
  /** The whole-page draft, or `null` until the person types. The slot starts the draft on the first input. */
  draft: CommentDraft | null;
  /** True when the card opened to write a comment, so the box takes the focus. */
  autofocus: boolean;
  /** The box was emptied with Esc. The island closes. */
  onCancel: () => void;
}

/** True when the island shows the thread: a whole-page thread of the state's subject. */
export function isPageIslandThread(state: CommentsState, thread: CommentThread): boolean {
  const subject = state.subject.value;
  return thread.anchor.kind === "page" && thread.subject.kind === subject.kind && thread.subject.id === subject.id;
}

const openMs = 250;
const closeMs = 180;
const avatarCount = 3;

/**
 * The island at the top center of the screen for comments on the whole page. It shows the count of open whole-page
 * threads, and in comment mode a call to comment on the whole page. A click opens it as a card with those threads and a
 * box for a new one. `CommentLayer` renders it.
 */
export const CommentPageIsland = defineComponent({
  name: "CommentPageIsland",
  props: {
    comments: { required: true, type: Object as PropType<CommentsState> },
    readOnly: { default: false, type: Boolean },
  },
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<{ thread: { thread: CommentThread }; composer: CommentPageIslandComposerScope }>,
  setup(props, { slots }) {
    const UIcon = useUIComponent("UIcon");
    const icons = useViteHubUIIcons();
    const state = props.comments;
    const root = ref<HTMLElement>();
    const trigger = ref<HTMLElement>();
    const portals = new Set<Ref<HTMLElement | undefined>>();
    provide(commentThreadPortals, portals);

    const threads = computed(() => state.pageThreads.value.filter((thread) => thread.anchor.kind === "page"));
    const openThreads = computed(() => threads.value.filter((thread) => thread.status === "open"));
    const draft = computed(() => (state.draft.value?.anchor.kind === "page" ? state.draft.value : null));
    const opened = computed(() => (state.opened.value && isPageIslandThread(state, state.opened.value) ? state.opened.value : null));
    const mayComment = computed(() => !props.readOnly && Boolean(state.user.value));
    const expanded = ref(false);
    const hidden = computed(() => state.visibility.value === "hidden");
    const uiRoot = (): Document | ShadowRoot => {
      const node = root.value?.getRootNode();
      return node instanceof ShadowRoot ? node : document;
    };

    const status = computed<CommentPageIslandState>(() => {
      if (draft.value || opened.value) return "open";
      if (hidden.value) return "none";
      if (expanded.value && (threads.value.length > 0 || mayComment.value)) return "open";
      if (state.active.value && mayComment.value) return "hint";
      return openThreads.value.length > 0 ? "count" : "none";
    });

    const instant = ref(true);
    let readyFrame = 0;
    const stopReady = watch(() => state.status.value, (value) => {
      if (value === "idle" || value === "loading" || readyFrame) return;
      readyFrame = requestAnimationFrame(() => {
        readyFrame = requestAnimationFrame(() => {
          instant.value = false;
          stopReady();
        });
      });
    }, { immediate: true });

    const closing = ref(false);
    const settled = ref(false);
    let shownThread: CommentThread | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const still = () => instant.value || prefersReducedMotion();
    watch(status, (next, previous) => {
      clearTimeout(closeTimer);
      clearTimeout(settleTimer);
      if (next === "open") {
        closing.value = false;
        if (previous === "open") return;
        settled.value = false;
        if (still()) settled.value = true;
        else settleTimer = setTimeout(() => (settled.value = true), openMs);
        return;
      }
      settled.value = false;
      if (previous !== "open" || still()) {
        closing.value = false;
        return;
      }
      closing.value = true;
      closeTimer = setTimeout(() => (closing.value = false), closeMs);
    });
    watch(hidden, (value) => {
      if (value) expanded.value = false;
    });
    watch(opened, (thread, previous) => {
      if (thread) {
        expanded.value = true;
        return;
      }
      if (!previous || status.value !== "open") return;
      const focused = uiRoot().activeElement;
      if (focused && root.value?.contains(focused)) return;
      void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-slot='comment-page-island-item'][data-thread-id='${previous.id}']`)?.focus());
    }, { flush: "post" });

    const dirty = () => (root.value ? hasDirtyComposer(root.value) : false) || (draft.value?.body.trim().length ?? 0) > 0;
    const inPortal = (path: Element[]) => [...portals].some((portal) => portal.value && path.includes(portal.value));

    const collapse = (): void => {
      const focused = uiRoot().activeElement;
      const inside = Boolean(focused && root.value?.contains(focused));
      expanded.value = false;
      if (draft.value) state.cancelDraft();
      if (opened.value) state.close();
      if (inside) void nextTick(() => trigger.value?.focus({ preventScroll: true }));
    };
    const tryCollapse = (escape = false): boolean => {
      if (dirty()) {
        if (root.value) shakeDirtyComposers(root.value, escape);
        return false;
      }
      collapse();
      return true;
    };

    useDocumentPointerDown((event) => {
      if (status.value !== "open" || !root.value) return;
      const path = pathOf(event);
      if (path.includes(root.value) || inPortal(path) || consumedPointerEvents.has(event)) return;
      if (!path.some((element) => element.matches("[data-slot='comment-pin']"))) consumedPointerEvents.add(event);
      if (tryCollapse()) return;
      event.stopPropagation();
      swallowNextClick();
    });
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat || status.value !== "open") return;
      const path = pathOf(event);
      if (inPortal(path) || path.some((element) => element.matches("[data-slot='comment-composer']"))) return;
      event.preventDefault();
      tryCollapse(true);
    };
    onMounted(() => document.addEventListener("keydown", onKeydown, true));
    onBeforeUnmount(() => {
      document.removeEventListener("keydown", onKeydown, true);
      stopReady();
      cancelAnimationFrame(readyFrame);
      clearTimeout(closeTimer);
      clearTimeout(settleTimer);
    });

    const press = () => {
      if (status.value === "open") {
        tryCollapse();
        return;
      }
      if (status.value === "hint") {
        try {
          state.startDraft("page");
        } catch {}
        return;
      }
      expanded.value = true;
    };

    const people = (): AvatarStackPerson[] => {
      const seen = new Map<string, AvatarStackPerson>();
      for (const thread of openThreads.value) {
        const person = writerPerson(thread);
        if (!seen.has(person.id)) seen.set(person.id, person);
      }
      return [...seen.values()].slice(0, avatarCount);
    };

    const rows = (): VNode =>
      h("ul", { "data-slot": "comment-page-island-items" }, threads.value.map((thread) =>
        h("li", { key: thread.id }, h("button", {
          "data-focus-inset": "",
          "data-slot": "comment-page-island-item",
          "data-status": thread.status,
          "data-thread-id": thread.id,
          onClick: () => {
            expanded.value = true;
            state.open(thread);
          },
          type: "button",
        }, threadRow(thread)))));

    const content = (): Array<VNode | null> => {
      const showing = opened.value ?? (closing.value ? shownThread : undefined);
      if (status.value === "open") shownThread = opened.value ?? undefined;
      if (showing && slots.thread) return slots.thread({ thread: showing });
      return [
        threads.value.length > 0 ? rows() : null,
        mayComment.value && slots.composer
          ? h("div", { "data-draft": "true", "data-slot": "comment-page-island-composer", key: "composer" }, slots.composer({
              autofocus: Boolean(draft.value),
              draft: draft.value,
              onCancel: collapse,
            }))
          : null,
      ];
    };

    return () => {
      const current = status.value;
      const isOpen = current === "open";
      const count = openThreads.value.length;
      const labelled = current === "hint" || (isOpen && mayComment.value);
      const label = labelled ? "Comment on the whole page" : `${count} ${count === 1 ? "comment" : "comments"} on the whole page`;
      return h("div", {
        "data-instant": instant.value ? "" : undefined,
        "data-label": labelled ? "" : undefined,
        "data-slot": "comment-page-island",
        "data-state": current,
        ref: root,
      }, h("div", {
        "data-motion": instant.value ? "none" : undefined,
        "data-motion-panel": "",
        "data-open": isOpen ? "" : undefined,
        "data-slot": "comment-page-island-card",
      }, [
        h("button", {
          "aria-expanded": String(isOpen),
          "aria-label": labelled && count > 0 ? `${label}, ${count} open` : label,
          "data-motion": "none",
          "data-slot": "comment-page-island-trigger",
          onClick: press,
          ref: trigger,
          type: "button",
        }, [
          h("span", { "data-slot": "comment-page-island-label" }, h("span", h("span", [
            h(UIcon, { "aria-hidden": "true", name: icons.value.commentPage }),
            h("span", "Comment on the whole page"),
          ]))),
          count > 0
            ? h("span", { "data-slot": "comment-page-island-count" }, [
                h(AvatarStack, { "aria-hidden": "true", max: null, people: people(), size: "sm" }),
                h("span", String(count)),
              ])
            : null,
        ]),
        h("div", { "data-settled": settled.value ? "" : undefined, "data-slot": "comment-page-island-body", inert: !isOpen || undefined },
          h("div", { "data-slot": "comment-page-island-content" }, isOpen || closing.value ? content() : [])),
      ]));
    };
  },
});
