import {
  computed,
  defineComponent,
  h,
  inject,
  mergeProps,
  provide,
  useId,
  type Component,
  type ComputedRef,
  type InjectionKey,
  type PropType,
  type Ref,
} from "vue";
import { uiErrorDiagnostics } from "../error-diagnostics.ts";
import { asProp } from "../internal/slot-part.ts";

// These parts turn an input into a Choices request: the text box, its status for screen readers, a clear control, and
// the error. They hold no state of their own. The state comes from the object that `useChoices()` returns.

export type ChoicesInputState = "idle" | "thinking" | "ready" | "error";

/**
 * What the parts need from `useChoices()`. The type is structural, so any object of this shape works and no server
 * code reaches the browser.
 */
export interface ChoicesInputSource {
  abort: () => void;
  clear: () => void;
  error: Readonly<Ref<Error | undefined>>;
  status: Readonly<Ref<ChoicesInputState>>;
  submit: () => Promise<void> | void;
  text: Ref<string>;
}

interface ChoicesInputContext {
  choices: ComputedRef<ChoicesInputSource>;
  errorId: string;
}

const choicesInputKey: InjectionKey<ChoicesInputContext> = Symbol("ViteHubChoicesInput");

function useChoicesInputContext(part: string): ChoicesInputContext {
  const context = inject(choicesInputKey);
  if (!context)
    throw uiErrorDiagnostics.UI_R0002({ message: `${part} must be used inside ChoicesInput.` });
  return context;
}

// Every part carries the state, so one CSS selector styles a part for each state.
const stateAttributes = (slot: string, choices: ChoicesInputSource) => ({ "data-slot": slot, "data-state": choices.status.value });

export const ChoicesInput = defineComponent({
  name: "ChoicesInput",
  props: {
    /** The object that `useChoices()` returns. */
    choices: { required: true, type: Object as PropType<ChoicesInputSource> },
  },
  setup(props, { attrs, slots }) {
    provide(choicesInputKey, { choices: computed(() => props.choices), errorId: useId() });
    return () => h("div", { ...attrs, ...stateAttributes("choices-input", props.choices) }, slots.default?.({ state: props.choices.status.value }));
  },
});

export const ChoicesInputField = defineComponent({
  name: "ChoicesInputField",
  inheritAttrs: false,
  props: {
    /** The element or component to render. A component receives `modelValue` and `onUpdate:modelValue`. Default `input`. */
    as: asProp("input"),
    /** The accessible name of the input. Default `"Search"`. */
    label: { default: "Search", type: String },
  },
  setup(props, { attrs, slots }) {
    const { choices, errorId } = useChoicesInputContext("ChoicesInputField");
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        void choices.value.submit();
      } else if (event.key === "Escape") {
        const { status, text } = choices.value;
        // Leave Escape to the page, for example a dialog, when there is nothing to clear.
        if (status.value === "idle" && text.value === "") return;
        event.preventDefault();
        if (status.value === "thinking") choices.value.abort();
        choices.value.clear();
      }
    };
    return () => {
      const { status, text } = choices.value;
      const failed = status.value === "error";
      const shared = mergeProps({ autocomplete: "off" }, attrs, {
        "aria-busy": status.value === "thinking" ? "true" : "false",
        "aria-describedby": failed
          ? [attrs["aria-describedby"], errorId].filter(Boolean).join(" ")
          : attrs["aria-describedby"],
        "aria-invalid": failed ? "true" : undefined,
        "aria-label": attrs["aria-labelledby"] ? undefined : props.label,
        ...stateAttributes("choices-input-field", choices.value),
        onKeydown: keydown,
      });
      if (typeof props.as === "string")
        return h(
          props.as,
          mergeProps(shared, {
            enterkeyhint: "search",
            onInput: (event: Event) => {
              text.value = (event.target as HTMLInputElement).value;
            },
            spellcheck: false,
            type: "text",
            value: text.value,
          }),
        );
      return h(
        props.as as Component,
        mergeProps(shared, {
          modelValue: text.value,
          "onUpdate:modelValue": (value: string) => {
            text.value = value;
          },
        }),
        slots,
      );
    };
  },
});

export const ChoicesInputClear = defineComponent({
  name: "ChoicesInputClear",
  props: {
    /** The element or component to render, for example a button of your design system. Default `button`. */
    as: asProp("button"),
    /** The accessible name of the button. Default `"Clear"`. */
    label: { default: "Clear", type: String },
  },
  setup(props, { attrs, slots }) {
    const { choices } = useChoicesInputContext("ChoicesInputClear");
    return () =>
      h(
        props.as,
        {
          ...attrs,
          "aria-label": props.label,
          ...stateAttributes("choices-input-clear", choices.value),
          onClick: () => {
            if (choices.value.status.value === "thinking") choices.value.abort();
            choices.value.clear();
          },
          type: "button",
        },
        slots.default?.(),
      );
  },
});

const statusMessages: Record<ChoicesInputState, string> = {
  error: "",
  idle: "",
  ready: "Ready",
  thinking: "Thinking",
};

// A polite live region. It stays in the page from the first render, because a screen reader announces only a change
// inside a region that already exists.
export const ChoicesInputStatus = defineComponent({
  name: "ChoicesInputStatus",
  setup(_props, { attrs, slots }) {
    const { choices } = useChoicesInputContext("ChoicesInputStatus");
    return () => {
      const { error, status } = choices.value;
      const message = status.value === "error" ? (error.value?.message ?? "Something went wrong") : statusMessages[status.value];
      return h(
        "div",
        { ...attrs, "aria-atomic": "true", "aria-live": "polite", ...stateAttributes("choices-input-status", choices.value), role: "status" },
        slots.default?.({ message, state: status.value }) ?? message,
      );
    };
  },
});

// The error as visible text. It renders only after a failed request, and the input points to it with `aria-describedby`.
export const ChoicesInputError = defineComponent({
  name: "ChoicesInputError",
  setup(_props, { attrs, slots }) {
    const { choices, errorId } = useChoicesInputContext("ChoicesInputError");
    return () => {
      const { error, status } = choices.value;
      if (status.value !== "error") return null;
      return h(
        "p",
        { ...attrs, id: errorId, ...stateAttributes("choices-input-error", choices.value) },
        slots.default?.({ error: error.value }) ?? error.value?.message ?? "Something went wrong",
      );
    };
  },
});
