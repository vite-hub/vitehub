import { computed, defineComponent, h, nextTick, type PropType, ref, type Ref } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/** One step of a lesson. The guide shows its title over the step's text, and the steps menu lists it. */
export interface WorkspaceStep {
  title: string;
  /** A short line under the title in the steps menu. */
  description?: string;
}

/**
 * The current step of `v-model:step`, from 0, kept inside the steps. Without a `step` prop the part keeps its own.
 * `go(index)` moves to a step that exists and does nothing for one that does not.
 */
export function useStepModel(
  props: { step: number | undefined; steps: readonly WorkspaceStep[] },
  emit: (event: "update:step", step: number) => void,
) {
  const local: Ref<number> = ref(0);
  const current = computed(() => {
    const last = Math.max(0, props.steps.length - 1);
    return Math.min(last, Math.max(0, Math.trunc(props.step ?? local.value)));
  });
  function go(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= props.steps.length || index === current.value) return;
    local.value = index;
    emit("update:step", index);
  }
  return { current, go };
}

const focusable = "button:not(:disabled), a[href]";

/**
 * After a move from a control inside `root`, focus the control that `pick` returns when the move removed or disabled
 * the focused one. Focus that is still on a live control stays where it is.
 */
export function keepFocus(root: () => HTMLElement | null, pick: (controls: HTMLElement[]) => HTMLElement | undefined) {
  void nextTick(() => {
    const element = root();
    if (!element || typeof document === "undefined") return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || (active instanceof HTMLButtonElement && active.disabled);
    if (lost) pick([...element.querySelectorAll<HTMLElement>(focusable)])?.focus();
  });
}

/**
 * The steps of a lesson for the bar of a workspace: a menu with every step, the position, and Back and Next.
 * Use `v-model:step`. The step is a 0-based index.
 */
export const WorkspaceSteps = defineComponent({
  name: "WorkspaceSteps",
  props: {
    /** The steps of the lesson, in order. */
    steps: { required: true, type: Array as PropType<readonly WorkspaceStep[]> },
    /** The current step, from 0. Use `v-model:step`. */
    step: { default: undefined, type: Number },
    /** A heading over the steps in the menu, such as the name of the lesson. */
    label: { default: undefined, type: String },
  },
  emits: {
    "update:step": (step: number) => Number.isInteger(step),
  },
  setup(props, { emit }) {
    const { current, go } = useStepModel(props, emit);
    const UButton = useUIComponent("UButton");
    const UDropdownMenu = useUIComponent("UDropdownMenu");
    const nav = ref<HTMLElement | null>(null);

    // An arrow is disabled at the first and last step. Focus then goes to the other arrow, or to the menu.
    function move(index: number, other: string) {
      go(index);
      keepFocus(() => nav.value, controls => controls.find(control => control.matches(other)) ?? controls[0]);
    }

    return () => {
      const total = props.steps.length;
      const index = current.value;
      const title = props.steps[index]?.title ?? "";
      const name = total ? `${index + 1}. ${title}` : "";
      const items = props.steps.map((item, position) => ({
        description: item.description,
        label: `${position + 1}. ${item.title}`,
        onSelect: () => go(position),
      }));
      return h("nav", { "aria-label": "Steps", class: "vh-ws-step-nav", ref: nav }, [
        h(UDropdownMenu, {
          content: { align: "start" },
          items: props.label ? [[{ label: props.label, type: "label" }], items] : [items],
          ui: { content: "w-72" },
        }, () => h(UButton, {
          "aria-label": `Step: ${name}`,
          class: "vh-ws-step-nav-menu",
          color: "neutral",
          size: "sm",
          trailingIcon: "i-lucide-chevron-down",
          variant: "ghost",
        }, () => h("span", { class: "vh-ws-step-nav-name" }, name))),
        h("span", { class: "vh-ws-step-nav-count" }, total ? `Step ${index + 1} of ${total}` : ""),
        h(UButton, {
          "aria-label": "Previous step",
          class: "vh-ws-step-nav-back",
          color: "neutral",
          disabled: index === 0,
          icon: "i-lucide-chevron-left",
          size: "sm",
          square: true,
          variant: "ghost",
          onClick: () => move(index - 1, ".vh-ws-step-nav-next"),
        }),
        h(UButton, {
          "aria-label": "Next step",
          class: "vh-ws-step-nav-next",
          color: "neutral",
          disabled: index >= total - 1,
          icon: "i-lucide-chevron-right",
          size: "sm",
          square: true,
          variant: "ghost",
          onClick: () => move(index + 1, ".vh-ws-step-nav-back"),
        }),
      ]);
    };
  },
});
