import { computed, defineComponent, h, type PropType } from "vue";

// Named after the presence stacks of Liveblocks, Kibo UI, and Supabase UI, which all call it `AvatarStack`.
// `max` counts the "+N" item, as in Liveblocks.

/** One person in the stack. A Realtime `people` entry fits as it is. */
export interface AvatarStackPerson {
  id: string;
  name: string;
  image?: string;
  /** The person's presence color, `#RRGGBB`. The `outline` variant rings the avatar with it, to match their caret. */
  color?: string;
}

export type AvatarStackSize = "sm" | "default" | "lg";
export type AvatarStackVariant = "default" | "outline";

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  // SAFETY: `words.at(-1)` exists when `words.length > 1`.
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words.at(-1)![0] : (words[0]?.[1] ?? ""))).toUpperCase() || "?";
}

export const AvatarStack = defineComponent({
  name: "AvatarStack",
  props: {
    /** Each person once: entries with the same `id` (a person in two tabs) show one avatar. */
    // SAFETY: Vue uses this constructor only for runtime validation; the generic preserves the public prop type.
    people: { required: true, type: Array as PropType<AvatarStackPerson[]> },
    /** The most items to show, counting the "+N" item. `null` shows everyone. */
    // SAFETY: Vue's runtime constructors cannot express nullable numeric props or string literal unions.
    max: { default: 3, type: [Number, null] as PropType<number | null> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    size: { default: "default", type: String as PropType<AvatarStackSize> },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    variant: { default: "default", type: String as PropType<AvatarStackVariant> },
  },
  setup(props) {
    const people = computed(() => {
      const seen = new Set<string>();
      return props.people.filter(person => !seen.has(person.id) && seen.add(person.id));
    });
    const shown = computed(() => {
      const max = props.max === null ? Number.POSITIVE_INFINITY : Math.max(2, props.max);
      return people.value.length > max ? people.value.slice(0, max - 1) : people.value;
    });
    const hidden = computed(() => people.value.slice(shown.value.length));

    return () =>
      h(
        "div",
        {
          "aria-label": `${people.value.length} ${people.value.length === 1 ? "person" : "people"}: ${people.value.map(person => person.name).join(", ")}`,
          "data-size": props.size,
          "data-slot": "avatar-stack",
          "data-variant": props.variant,
          role: "group",
        },
        [
          ...shown.value.map(person =>
            h(
              "span",
              {
                "aria-hidden": "true",
                "data-slot": "avatar-stack-item",
                key: person.id,
                style: person.color ? { "--vh-avatar-color": person.color } : undefined,
                title: person.name,
              },
              person.image
                ? h("img", { alt: "", "data-slot": "avatar-stack-image", src: person.image })
                : h("span", { "data-slot": "avatar-stack-fallback" }, initials(person.name)),
            ),
          ),
          hidden.value.length
            ? h(
                "span",
                { "aria-hidden": "true", "data-slot": "avatar-stack-count", title: hidden.value.map(person => person.name).join(", ") },
                `+${hidden.value.length}`,
              )
            : null,
        ],
      );
  },
});
