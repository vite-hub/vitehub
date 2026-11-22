import { computed, defineComponent, h, type PropType } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/** One example of a workspace: an app that the reader can open. */
export interface WorkspaceExample {
  /** The id in share links, where the key stays `template` so older links open. */
  id: string;
  label: string;
  description?: string;
  /** The heading that the example sits under in the menu. Examples without one come first, with no heading. */
  group?: string;
  /** The files of the example. The start screen shows how many there are. */
  files?: Readonly<Record<string, string>>;
}

/** The examples by group, in the order of their first example. Examples without a group come first. */
export function groupExamples<T extends WorkspaceExample>(examples: readonly T[]): { group?: string, examples: T[] }[] {
  const groups = new Map<string | undefined, T[]>([[undefined, []]]);
  for (const example of examples) {
    const list = groups.get(example.group) ?? [];
    list.push(example);
    groups.set(example.group, list);
  }
  return [...groups].filter(([, list]) => list.length > 0).map(([group, list]) => ({ examples: list, group }));
}

/**
 * The examples menu of the workspace bar. The button shows the open example. The menu lists the examples under their
 * group headings and checks the open one. The arrow keys move, a typed letter jumps to an example, and Enter opens it.
 * It does not open the example itself: it emits `update:modelValue`, so the page can ask before it replaces edits.
 */
export const WorkspaceExamples = defineComponent({
  name: "WorkspaceExamples",
  props: {
    examples: { required: true, type: Array as PropType<readonly WorkspaceExample[]> },
    modelValue: { default: undefined, type: [String, null] as PropType<string | null> },
    label: { default: "Example", type: String },
  },
  emits: {
    "update:modelValue": (id: string) => typeof id === "string",
  },
  setup(props, { emit }) {
    const UButton = useUIComponent("UButton");
    const UDropdownMenu = useUIComponent("UDropdownMenu");
    const current = computed(() => props.modelValue === null ? undefined : props.examples.find(example => example.id === props.modelValue) ?? props.examples[0]);
    const items = computed(() => groupExamples(props.examples).map(({ examples, group }) => [
      ...group ? [{ label: group, type: "label" as const }] : [],
      ...examples.map(example => ({
        checked: example.id === current.value?.id,
        description: example.description,
        label: example.label,
        onSelect: () => { if (example.id !== current.value?.id) emit("update:modelValue", example.id); },
        type: "checkbox" as const,
      })),
    ]));
    return () => h(UDropdownMenu, {
      content: { align: "start", sideOffset: 6 },
      items: items.value,
      ui: { content: "vh-ws-examples-menu" },
    }, () => h(UButton, {
      "aria-label": props.modelValue === null ? `Choose ${props.label.toLowerCase()}` : `${props.label}: ${current.value?.label ?? "none"}`,
      class: "vh-ws-bar-button vh-ws-examples-button",
      color: "neutral",
      trailingIcon: "i-lucide-chevron-down",
      variant: "ghost",
    }, () => [h("span", { class: "vh-ws-muted" }, props.label), h("span", { class: "vh-ws-examples-current" }, current.value?.label)]));
  },
});
