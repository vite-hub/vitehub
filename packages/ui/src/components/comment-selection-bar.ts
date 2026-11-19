import { type Component, defineComponent, h, onErrorCaptured, onMounted, type PropType, ref, type VNode } from "vue";
import { useViteHubUIIcons } from "../config.ts";
import { useTooltipComponent, useUIComponent } from "../internal/nuxt-ui.ts";

// Nuxt UI's tooltip, registered by name, throws when no `UApp` gives it a provider. Then the button shows alone, with
// its `title`. Only an error while the tooltip mounts falls back; a later one, such as from a click, goes on up.
const TooltipOrTitle = defineComponent({
  name: "CommentSelectionBarTooltip",
  props: {
    // SAFETY: Vue's runtime constructors cannot express a component type.
    tooltip: { required: true, type: [Object, Function] as PropType<Component> },
    side: { required: true, type: String as PropType<CommentSelectionBarSide> },
    content: { required: true, type: Function as PropType<() => Array<string | VNode>> },
    trigger: { required: true, type: Function as PropType<(title?: string) => VNode> },
    title: { required: true, type: String },
  },
  setup(props) {
    const failed = ref(false);
    let mounted = false;
    onMounted(() => (mounted = true));
    onErrorCaptured(() => {
      if (mounted || failed.value) return;
      failed.value = true;
      return false;
    });
    return () =>
      failed.value
        ? props.trigger(props.title)
        : h(props.tooltip, { content: { side: props.side, sideOffset: 8 } }, { content: props.content, default: () => props.trigger() });
  },
});

/** The side of the selected text that the bar sits on. */
export type CommentSelectionBarSide = "top" | "bottom";

type Action = { name: "comment" | "suggest"; label: string; hint: string; key: string; icon: string };

/**
 * The bar over selected text: Comment, and Suggest when the page takes suggested changes. It is the dark surface on a
 * light page and its light twin on a dark one, so it stands out from the text. The page places it and listens for the
 * keys. A press on the bar keeps the selection on the page.
 */
export const CommentSelectionBar = defineComponent({
  name: "CommentSelectionBar",
  props: {
    /** Show Suggest (E), for a page that takes suggested changes. */
    suggest: { default: false, type: Boolean },
    /** The side of the text that the bar is on. The bar grows from that side, and its tooltips open away from the text. */
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    side: { default: "top", type: String as PropType<CommentSelectionBarSide> },
  },
  emits: ["comment", "suggest"],
  setup(props, { emit }) {
    const UIcon = useUIComponent("UIcon");
    const UTooltip = useTooltipComponent();
    const icons = useViteHubUIIcons();

    const actions = (): Action[] => [
      { name: "comment", label: "Comment", hint: "Comment on the selected text", key: "C", icon: icons.value.comment },
      ...(props.suggest ? [{ name: "suggest", label: "Suggest", hint: "Suggest new words", key: "E", icon: icons.value.edit } as const] : []),
    ];

    const button = (action: Action, title?: string) =>
      h(
        "button",
        {
          "aria-keyshortcuts": action.key,
          "data-action": action.name,
          "data-slot": "comment-selection-bar-action",
          onClick: () => (action.name === "comment" ? emit("comment") : emit("suggest")),
          title,
          type: "button",
        },
        [h(UIcon, { "aria-hidden": "true", name: action.icon }), action.label],
      );

    return () =>
      h(
        "div",
        {
          "aria-label": "Selected text",
          "data-side": props.side,
          "data-slot": "comment-selection-bar",
          // A press here must not take the selection away from the page.
          onMousedown: (event: MouseEvent) => event.preventDefault(),
          role: "group",
        },
        actions().map((action) => {
          const title = `${action.hint} (${action.key})`;
          if (!UTooltip) return button(action, title);
          return h(TooltipOrTitle, {
            content: () => [action.hint, h("kbd", { "data-slot": "comment-selection-bar-kbd" }, action.key)],
            key: action.name,
            side: props.side,
            title,
            tooltip: UTooltip,
            trigger: (fallback?: string) => button(action, fallback),
          });
        }),
      );
  },
});
