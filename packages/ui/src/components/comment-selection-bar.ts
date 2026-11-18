import { defineComponent, h, type PropType } from "vue";
import { useViteHubUIIcons } from "../config.ts";
import { useTooltipComponent, useUIComponent } from "../internal/nuxt-ui.ts";

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
        actions().map((action) =>
          UTooltip
            ? h(UTooltip, { content: { side: props.side, sideOffset: 8 }, key: action.name }, {
                content: () => [action.hint, h("kbd", { "data-slot": "comment-selection-bar-kbd" }, action.key)],
                default: () => button(action),
              })
            : button(action, `${action.hint} (${action.key})`),
        ),
      );
  },
});
