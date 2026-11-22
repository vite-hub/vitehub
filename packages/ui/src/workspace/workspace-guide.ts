import { defineComponent, h, type PropType, ref, watch } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { keepFocus, useStepModel, type WorkspaceStep } from "./workspace-steps.ts";

/**
 * The guide of a lesson: the step's position and title, the page's text in the default slot, and Back and Next at the
 * bottom of the column. It never parses Markdown: render the step's text into the slot. Put it in the `guide` slot of
 * the shell, in the `guide-top` or `guide-side` layout. Use `v-model:step`; the step is a 0-based index.
 */
export const WorkspaceGuide = defineComponent({
  name: "WorkspaceGuide",
  props: {
    /** The steps of the lesson, in order. The guide shows the title of the current one. */
    steps: { default: () => [], type: Array as PropType<readonly WorkspaceStep[]> },
    /** The current step, from 0. Use `v-model:step`. */
    step: { default: undefined, type: Number },
    /** The title over the text. Defaults to the title of the current step. */
    title: { default: undefined, type: String },
  },
  emits: {
    "update:step": (step: number) => Number.isInteger(step),
  },
  setup(props, { emit, slots }) {
    const { current, go } = useStepModel(props, emit);
    const UButton = useUIComponent("UButton");
    const body = ref<HTMLElement | null>(null);
    const nav = ref<HTMLElement | null>(null);

    // Back leaves the footer on the first step and Next on the last. Focus then goes to the control that is left at the
    // end of the move: the first one after Back, the last one (Next or the finish action) after Next.
    function move(index: number) {
      const forward = index > current.value;
      go(index);
      keepFocus(() => nav.value, controls => forward ? controls.at(-1) : controls[0]);
    }

    // A new step starts at its top.
    watch(current, () => body.value?.scrollTo?.({ top: 0 }));

    return () => {
      const index = current.value;
      const total = props.steps.length;
      const previous = props.steps[index - 1];
      const next = props.steps[index + 1];
      const title = props.title ?? props.steps[index]?.title;
      const slotProps = { next: () => move(index + 1), previous: () => move(index - 1), step: index, total };

      // One step has no Back or Next, but a page's footer or finish action still shows. No steps yet has no finish action.
      const content = slots.footer?.(slotProps) ?? (total > 1
        ? [
            previous
              ? h(UButton, {
                  "aria-label": `Back to step ${index}: ${previous.title}`,
                  class: "vh-ws-guide-back",
                  color: "neutral",
                  icon: "i-lucide-chevron-left",
                  label: previous.title,
                  size: "sm",
                  variant: "ghost",
                  onClick: () => move(index - 1),
                })
              : h("span"),
            next
              ? h(UButton, {
                  class: "vh-ws-guide-next",
                  color: "neutral",
                  label: `Next: ${next.title}`,
                  size: "sm",
                  trailingIcon: "i-lucide-chevron-right",
                  variant: "solid",
                  onClick: () => move(index + 1),
                })
              : slots.finish?.(slotProps),
          ]
        : total === 1 && slots.finish ? [h("span"), slots.finish(slotProps)] : undefined);
      const footer = content
        ? h("nav", { "aria-label": "Step navigation", class: "vh-ws-guide-footer", ref: nav }, content)
        : undefined;

      return h("article", { class: "vh-ws-guide-pane", "data-step": total ? index : undefined }, [
        h("div", { class: "vh-ws-guide-body", ref: body }, [
          total > 1 ? h("p", { class: "vh-ws-guide-kicker" }, `Step ${index + 1} of ${total}`) : undefined,
          title ? h("h2", { class: "vh-ws-guide-title" }, title) : undefined,
          h("div", { class: "vh-ws-guide-content" }, slots.default?.(slotProps)),
        ]),
        footer,
      ]);
    };
  },
});
