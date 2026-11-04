import type { CommentThread } from "@vite-hub/comments/client";
import { defineComponent, h, type PropType, type SlotsType } from "vue";
import { type CommentFilterState, type CommentsState, useCommentsContext } from "../headless/comments.ts";
import { threadRow } from "../internal/comment-row.ts";
import { AvatarStack, type AvatarStackPerson } from "./avatar-stack.ts";
import type { CommentRowSlots } from "./comment-panel.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

// The `comments` prop lets a part work outside `CommentLayer`. Inside it, the part uses the layer's state.
const commentsProp = { type: Object as PropType<CommentsState> };

// Open, Resolved, and Mine. Resolved threads stay out of the pins and the list until Resolved is on.
export const CommentFilters = defineComponent({
  name: "CommentFilters",
  props: { comments: commentsProp },
  setup(props) {
    const UButton = useUIComponent("UButton");
    const comments = useCommentsContext(props.comments);
    return () => {
      const button = (key: keyof CommentFilterState, label: string, count?: number) =>
        h(
          UButton,
          {
            "aria-pressed": String(comments.filters[key]),
            color: "neutral",
            "data-slot": "comment-filter",
            "data-state": comments.filters[key] ? "on" : "off",
            key,
            label: count === undefined ? label : `${label} ${count}`,
            onClick: () => (comments.filters[key] = !comments.filters[key]),
            size: "xs",
            variant: comments.filters[key] ? "soft" : "ghost",
          },
        );
      return h("div", { "aria-label": "Filter comments", "data-slot": "comment-filters", role: "group" }, [
        button("open", "Open", comments.counts.value.open),
        button("resolved", "Resolved", comments.counts.value.resolved),
        button("mine", "Mine"),
      ]);
    };
  },
});

// The side list of threads for this page or the whole site. A click opens the thread on this page, or goes to the page of the thread.
export const CommentList = defineComponent({
  name: "CommentList",
  props: {
    comments: commentsProp,
    /** Goes to the page of a thread that is not on this page. Defaults to `location.assign`. */
    navigate: { type: Function as PropType<(href: string) => void> },
  },
  emits: ["select"],
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<CommentRowSlots>,
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    const comments = useCommentsContext(props.comments);

    function select(thread: CommentThread, event?: MouseEvent) {
      emit("select", thread);
      // A click with a modifier key keeps its browser meaning, such as opening a tab.
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0)) return;
      event?.preventDefault();
      const here = thread.subject.kind === comments.subject.value.kind && thread.subject.id === comments.subject.value.id;
      if (here) comments.open(thread, { scroll: true });
      else if (comments.close()) (props.navigate ?? ((href: string) => window.location.assign(href)))(comments.link(thread));
    }

    return () => {
      const scopeButton = (value: "page" | "site", label: string) =>
        h(UButton, {
          "aria-pressed": String(comments.scope.value === value),
          color: "neutral",
          "data-slot": "comment-list-scope",
          label,
          onClick: () => (comments.scope.value = value),
          size: "xs",
          variant: comments.scope.value === value ? "soft" : "ghost",
        });
      const rows = comments.listed.value;
      return h("section", { "aria-label": "Comments", "data-comments-ui": "", "data-slot": "comment-list" }, [
        h("header", { "data-slot": "comment-list-header" }, [
          h("div", { "data-slot": "comment-list-scopes", role: "group", "aria-label": "Scope" }, [
            scopeButton("page", "This page"),
            scopeButton("site", "All pages"),
          ]),
          h(CommentFilters, { comments }),
        ]),
        rows.length === 0
          ? h(
              "p",
              { "data-slot": "comment-list-empty", role: "status" },
              comments.status.value === "loading" && comments.threads.value.length === 0
                ? "Loading comments."
                : comments.status.value === "error"
                  ? "The comments could not load."
                  : "No comments here.",
            )
          : h(
              "ol",
              { "data-slot": "comment-list-items" },
              rows.map((thread) => {
                const detached = comments.positions.value.get(thread.id)?.detached === true;
                return h("li", { key: thread.id }, [
                  h(
                    "a",
                    {
                      "aria-current": comments.openId.value === thread.id ? "true" : undefined,
                      "data-detached": detached ? "true" : undefined,
                      "data-slot": "comment-list-item",
                      "data-status": thread.status,
                      href: comments.link(thread),
                      onClick: (event: MouseEvent) => select(thread, event),
                    },
                    slots.row?.({ thread }) ?? threadRow(thread, { detached, preview: slots.preview?.({ thread }), site: comments.scope.value === "site" }),
                  ),
                ]);
              }),
            ),
      ]);
    };
  },
});

// The Figma bar: the comment tool, the list of threads, and who else is on the page.
export const CommentToolbar = defineComponent({
  name: "CommentToolbar",
  props: {
    comments: commentsProp,
    /** The people on this page, from Realtime. Shown as a stack of avatars. */
    people: { default: () => [], type: Array as PropType<AvatarStackPerson[]> },
  },
  setup(props, { slots }) {
    const UButton = useUIComponent("UButton");
    const comments = useCommentsContext(props.comments);
    return () => {
      const open = comments.pageThreads.value.length;
      return h("div", { "aria-label": "Comments", "data-comments-ui": "", "data-slot": "comment-toolbar", role: "toolbar" }, [
        h(UButton, {
          "aria-keyshortcuts": "C",
          "aria-label": "Comment mode",
          "aria-pressed": String(comments.active.value),
          color: "neutral",
          "data-slot": "comment-toolbar-mode",
          icon: "i-ph-chat-circle",
          onClick: comments.toggle,
          size: "sm",
          title: "Comment (C)",
          variant: comments.active.value ? "solid" : "ghost",
        }),
        h(UButton, {
          "aria-label": `Comment list, ${open} on this page`,
          "aria-pressed": String(comments.listOpen.value),
          color: "neutral",
          "data-slot": "comment-toolbar-list",
          icon: "i-ph-list-bullets",
          label: String(open),
          onClick: () => (comments.listOpen.value = !comments.listOpen.value),
          size: "sm",
          variant: comments.listOpen.value ? "solid" : "ghost",
        }),
        // The keyboard way to comment on the page as a whole, and the way for a page that has no spot to point at.
        h(UButton, {
          "aria-label": "Comment on page",
          color: "neutral",
          "data-slot": "comment-toolbar-page",
          icon: "i-ph-note-pencil",
          onClick: () => {
            comments.startDraft("page");
          },
          size: "sm",
          title: "Comment on the whole page",
          variant: "ghost",
        }),
        props.people.length > 0 ? h(AvatarStack, { people: props.people, size: "sm", variant: "outline" }) : null,
        // Extra tools of the host, such as an Edit link.
        slots.default?.(),
      ]);
    };
  },
});
