import { computed, defineComponent, h, type PropType } from "vue";
import { initials } from "../internal/format.ts";

// Named after the presence stacks of Liveblocks, Kibo UI, and Supabase UI, which all call it `AvatarStack`.
// `max` counts the "+N" item, as in Liveblocks.

/** One person in the stack. A Realtime `people` entry fits as it is. */
export interface AvatarStackPerson {
  id: string;
  name: string;
  image?: string;
  /** The person's presence color, `#RRGGBB`. The `outline` variant rings the avatar with it, to match their caret. */
  color?: string;
  /** Away: the person is in the room but hasn't done anything for a while, or their tab is hidden. Their avatar dims. */
  idle?: boolean;
}

export type AvatarStackSize = "sm" | "default" | "lg";
export type AvatarStackVariant = "default" | "outline";

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
    // One entry per person, away only when every tab of theirs is, and the people who are here before the away ones,
    // so a short stack shows who is active.
    const people = computed(() => {
      const byId = new Map<string, AvatarStackPerson>();
      for (const person of props.people) {
        const seen = byId.get(person.id);
        if (!seen) byId.set(person.id, person);
        else if (seen.idle && !person.idle) byId.set(person.id, { ...seen, idle: false });
      }
      const all = [...byId.values()];
      return [...all.filter(person => !person.idle), ...all.filter(person => person.idle)];
    });
    const label = (person: AvatarStackPerson) => (person.idle ? `${person.name} (away)` : person.name);
    const shown = computed(() => {
      const max = props.max === null ? Number.POSITIVE_INFINITY : Math.max(2, props.max);
      return people.value.length > max ? people.value.slice(0, max - 1) : people.value;
    });
    const hidden = computed(() => people.value.slice(shown.value.length));

    return () =>
      h(
        "div",
        {
          "aria-label": `${people.value.length} ${people.value.length === 1 ? "person" : "people"}: ${people.value.map(label).join(", ")}`,
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
                "data-idle": person.idle ? "true" : undefined,
                "data-slot": "avatar-stack-item",
                key: person.id,
                style: person.color ? { "--vh-avatar-color": person.color } : undefined,
                title: label(person),
              },
              person.image
                ? h("img", { alt: "", "data-slot": "avatar-stack-image", src: person.image })
                : h("span", { "data-slot": "avatar-stack-fallback" }, initials(person.name)),
            ),
          ),
          hidden.value.length
            ? h(
                "span",
                { "aria-hidden": "true", "data-slot": "avatar-stack-count", title: hidden.value.map(label).join(", ") },
                `+${hidden.value.length}`,
              )
            : null,
        ],
      );
  },
});
