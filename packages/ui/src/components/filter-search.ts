import { defineComponent, h, type PropType } from "vue";
import { ChoicesInput, ChoicesInputClear, ChoicesInputError, ChoicesInputField, ChoicesInputStatus, type ChoicesInputSource } from "../headless/choices-input.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

export type FilterSearchSize = "xs" | "sm" | "md" | "lg" | "xl";

// A text box that fills filters. It owns no state and fetches nothing: the object from `useChoices()` does both, and
// the app applies the selection in `onSelect`. It renders no filter chips either, because the app owns those.
export const FilterSearch = defineComponent({
  name: "FilterSearch",
  props: {
    /** The object that `useChoices()` returns. */
    choices: { required: true, type: Object as PropType<ChoicesInputSource> },
    /** The accessible name of the input. */
    label: { default: "Search", type: String },
    placeholder: { type: String },
    size: { default: "md", type: String as PropType<FilterSearchSize> },
  },
  setup(props, { slots }) {
    const UButton = useUIComponent("UButton");
    const UIcon = useUIComponent("UIcon");
    const UInput = useUIComponent("UInput");
    return () =>
      h(ChoicesInput, { choices: props.choices, class: "vh-filter-search" }, () => [
        h(
          ChoicesInputField,
          { as: UInput, class: "w-full", label: props.label, placeholder: props.placeholder, size: props.size },
          {
            leading: slots.leading,
            trailing: () => [
              props.choices.status.value === "thinking"
                ? h(UIcon, { "aria-hidden": "true", class: "animate-spin", name: "i-ph-circle-notch" })
                : props.choices.text.value !== ""
                  ? h(ChoicesInputClear, { as: UButton, color: "neutral", icon: "i-ph-x", size: "xs", variant: "link" })
                  : null,
              slots.trailing?.(),
            ],
          },
        ),
        h(ChoicesInputStatus, { class: "vh-visually-hidden" }),
        h(ChoicesInputError, { class: "vh-filter-search-error" }, {
          default: ({ error }: { error: Error | undefined }) => slots.error?.({ error }) ?? error?.message,
        }),
      ]);
  },
});
