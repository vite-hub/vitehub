import {
  createChange,
  definePrimitive,
  idPart,
  isComposing,
  isRTL,
  type ChangeDetails,
  type ChangeOptions,
  type PrimitiveOptions,
  type SlotDefinition,
} from "@ui-sdk/core";

// Tags Input turns free text into tags. Enter or the delimiter adds the text
// as a tag, Backspace in an empty input removes the last tag, and the arrow
// keys move a highlight between tags while focus stays in the input, as in
// Reka UI. Backspace or Delete removes the highlighted tag.

/**
 * Why the tags changed, as `reason` in their change details: `"input-commit"`
 * for Enter, Tab, or leaving the input, `"input-change"` for a typed or pasted
 * delimiter, `"remove-press"` for an item's delete button, `"remove-key"` for
 * Backspace or Delete, `"clear-press"` for the clear button, and
 * `"imperative"` from the api.
 */
export type TagsInputValueChangeReason =
  | "input-commit"
  | "input-change"
  | "remove-press"
  | "remove-key"
  | "clear-press"
  | "imperative";

/** The options `tagsInputPrimitive` takes. A component takes them as props on its root. */
export type TagsInputOptions = {
  /** The tags. Bind it with `v-model`. */
  value?: string[];
  /** The tags it starts with, when you don't control `value`. */
  defaultValue?: string[];
  /** Called when a tag is added or removed. Cancel it to keep the tags as they were. */
  onValueChange?: (value: string[], details: ChangeDetails<TagsInputValueChangeReason>) => void;
  /**
   * The text that ends a tag as it's typed or pasted.
   * @defaultValue ","
   */
  delimiter?: string;
  /** Whether a paste adds its text as tags at once, split at the delimiter. */
  addOnPaste?: boolean;
  /** Whether Tab adds the text as a tag before focus moves on. */
  addOnTab?: boolean;
  /** Whether leaving the input adds its text as a tag. */
  addOnBlur?: boolean;
  /** The most tags it takes. No limit when left out. */
  max?: number;
  /** Stops adding and removing tags, and marks every part. */
  disabled?: boolean;
  /** Submits each tag with a form under this name, through hidden inputs. */
  name?: string;
  /** The id of the form the hidden inputs belong to, when it isn't inside it. */
  form?: string;
} & PrimitiveOptions;

/** The props the `item` slot of `tagsInputPrimitive` takes. */
export type TagsInputItemProps = {
  /** The tag. */
  value: string;
  /** Whether the tag can't be removed. */
  disabled?: boolean;
};

type PartProps = {
  /** @internal The tag, from the item it sits in. */
  value?: string;
  /** @internal Whether the tag can't be removed, from the item it sits in. */
  disabled?: boolean;
};

/** The state the `root`, `input`, and `clear` slots of `tagsInputPrimitive` hand `render` functions and state-based class names. */
export type TagsInputState = {
  /** The tags. */
  value: string[];
  /** Whether there are no tags. */
  empty: boolean;
  /** Whether the last text was refused, because the tag exists or there's no room. Typing again clears it. */
  invalid: boolean;
  disabled: boolean;
};

/** The state the `item`, `item-text`, and `item-delete` slots of `tagsInputPrimitive` hand `render` functions and state-based class names. */
export type TagsInputItemState = {
  /** The tag. */
  value: string;
  /** Whether the arrow keys put the highlight on it. */
  highlighted: boolean;
  disabled: boolean;
};

type TagsInputStore = {
  value: string[];
  highlighted: string | null;
  invalid: boolean;
  disabled: boolean;
  name: string | undefined;
  form: string | undefined;
};

/** `tagsInputPrimitive`'s api, which its slots call. Adapters expose it as `api`. */
export interface TagsInputApi {
  /** Adds text as a tag, trimmed. Returns false when it's empty, exists already, or there's no room. */
  add: (text: string, details?: ChangeOptions<TagsInputValueChangeReason>) => boolean;
  /** Removes a tag. */
  remove: (tag: string, details?: ChangeOptions<TagsInputValueChangeReason>) => boolean;
  /** Removes every tag. */
  clear: (details?: ChangeOptions<TagsInputValueChangeReason>) => boolean;
  internal: {
    keydown: (event: KeyboardEvent, input: HTMLInputElement) => void;
    input: (event: InputEvent, input: HTMLInputElement) => void;
    paste: (event: ClipboardEvent) => void;
    focusout: (event: FocusEvent, input: HTMLInputElement) => void;
  };
}

type Slot<Props, Public> = SlotDefinition<TagsInputStore, TagsInputApi, Props & { id?: string }, Public>;

type TagsInputSlots = {
  root: Slot<{}, TagsInputState>;
  item: Slot<TagsInputItemProps, TagsInputItemState>;
  "item-text": Slot<PartProps, TagsInputItemState>;
  "item-delete": Slot<PartProps, TagsInputItemState>;
  input: Slot<{}, TagsInputState>;
  clear: Slot<{}, TagsInputState>;
  "hidden-input": Slot<{ value?: string }, {}>;
};

/** The type of `tagsInputPrimitive`. */
export interface TagsInputPrimitive
  extends ReturnType<typeof definePrimitive<TagsInputOptions, TagsInputStore, TagsInputApi, TagsInputSlots>> {}

const fromOptions = (options: TagsInputOptions) => ({
  disabled: !!options.disabled,
  name: options.name,
  form: options.form,
});

const rootState = (state: TagsInputStore): TagsInputState => ({
  value: state.value,
  empty: state.value.length === 0,
  invalid: state.invalid,
  disabled: state.disabled,
});

const rootAttrs = (state: TagsInputStore) => ({
  "data-empty": state.value.length === 0 ? "" : undefined,
  "data-invalid": state.invalid ? "" : undefined,
  "data-disabled": state.disabled ? "" : undefined,
});

const itemState = (state: TagsInputStore, props: PartProps): TagsInputItemState => ({
  value: props.value ?? "",
  highlighted: props.value !== undefined && state.highlighted === props.value,
  disabled: state.disabled || !!props.disabled,
});

const itemAttrs = (state: TagsInputStore, props: PartProps) => {
  const item = itemState(state, props);
  return {
    "data-highlighted": item.highlighted ? "" : undefined,
    "data-disabled": item.disabled ? "" : undefined,
  };
};

const partId = (id: string, part: string, tag: string) => `${id}-${part}-${idPart(tag)}`;

const itemProps = {
  value: { kind: "string", from: "item", required: true },
  disabled: { kind: "boolean", from: "item.disabled" },
} as const;

const atStart = (input: HTMLInputElement) => input.selectionStart === 0 && input.selectionEnd === 0;

/**
 * The tags input primitive, with the slots `root`, `item`, `item-text`,
 * `item-delete`, `input`, `clear`, `hidden-input`. Render it with an adapter's
 * `createParts`.
 */
export const tagsInputPrimitive: TagsInputPrimitive = definePrimitive({
  name: "tags-input",
  options: {
    value: "list",
    defaultValue: "list",
    onValueChange: "callback",
    delimiter: "string",
    addOnPaste: "boolean",
    addOnTab: "boolean",
    addOnBlur: "boolean",
    max: "number",
    disabled: "boolean",
    name: "string",
    form: "string",
  },
  controlled: ["value"],
  state: (options: TagsInputOptions): TagsInputStore => ({
    value: options.value ?? options.defaultValue ?? [],
    highlighted: null,
    invalid: false,
    ...fromOptions(options),
  }),
  sync: (options) => ({
    ...fromOptions(options),
    ...(options.value === undefined ? {} : { value: options.value }),
  }),
  api: (context): TagsInputApi => {
    const { store, options } = context;
    const change = createChange(context);
    const set = (value: string[], details: ChangeOptions<TagsInputValueChangeReason>) =>
      change("value", value, { reason: details.reason ?? "imperative", event: details.event });
    const highlight = (tag: string | null) => {
      if (store.get().highlighted !== tag) store.set({ highlighted: tag });
    };
    const locked = (tag: string) =>
      !!context.props<{ disabled?: boolean }>("item", tag)?.disabled;

    // Adds every text at once, so a paste of several tags makes one change.
    function addAll(texts: string[], details: ChangeOptions<TagsInputValueChangeReason>) {
      const { value, disabled } = store.get();
      if (disabled) return false;
      const max = options().max;
      const next = [...value];
      let refused = false;
      for (const text of texts) {
        const tag = text.trim();
        if (!tag) continue;
        if (next.includes(tag) || (max !== undefined && next.length >= max)) refused = true;
        else next.push(tag);
      }
      if (refused) store.set({ invalid: true });
      return next.length > value.length && set(next, details) && !refused;
    }

    const api: TagsInputApi = {
      add: (text, details = {}) => addAll([text], details),
      remove(tag, details = {}) {
        const { value, disabled } = store.get();
        if (disabled || locked(tag) || !value.includes(tag)) return false;
        return set(
          value.filter((item) => item !== tag),
          details,
        );
      },
      clear(details = {}) {
        const { value, disabled } = store.get();
        if (disabled || !value.length) return false;
        return set([], details);
      },
      internal: {
        keydown(event, input) {
          if (isComposing(event) || event.defaultPrevented) return;
          const { value, highlighted } = store.get();
          const rtl = isRTL(input);
          const back = rtl ? "ArrowRight" : "ArrowLeft";
          const forward = rtl ? "ArrowLeft" : "ArrowRight";
          const index = highlighted === null ? -1 : value.indexOf(highlighted);
          switch (event.key) {
            case "Enter":
            case "Tab": {
              if (!input.value.trim() || (event.key === "Tab" && !options().addOnTab)) return;
              // Enter adds the tag instead of submitting the form.
              event.preventDefault();
              if (api.add(input.value, { reason: "input-commit", event })) input.value = "";
              return;
            }
            case "Backspace":
            case "Delete": {
              if (!atStart(input)) return;
              if (highlighted !== null) {
                event.preventDefault();
                // The highlight moves to the tag that takes the removed one's place.
                const next = value[index + 1] ?? value[index - 1] ?? null;
                if (api.remove(highlighted, { reason: "remove-key", event })) highlight(next);
                return;
              }
              const last = value.at(-1);
              if (event.key === "Backspace" && input.value === "" && last !== undefined) {
                event.preventDefault();
                api.remove(last, { reason: "remove-key", event });
              }
              return;
            }
            case back: {
              if (!atStart(input) || !value.length) return;
              event.preventDefault();
              highlight(index === -1 ? value.at(-1)! : value[Math.max(0, index - 1)]!);
              return;
            }
            case forward: {
              if (index === -1) return;
              event.preventDefault();
              highlight(value[index + 1] ?? null);
              return;
            }
            case "Home":
            case "End": {
              if (index === -1) return;
              event.preventDefault();
              highlight(event.key === "Home" ? value[0]! : null);
              return;
            }
            default:
              highlight(null);
          }
        },
        input(event, input) {
          if (store.get().invalid) store.set({ invalid: false });
          if (isComposing(event)) return;
          const delimiter = options().delimiter ?? ",";
          if (!delimiter || !input.value.includes(delimiter)) return;
          const texts = input.value.split(delimiter);
          const rest = texts.pop() ?? "";
          addAll(texts, { reason: "input-change", event });
          input.value = rest;
        },
        paste(event) {
          const text = event.clipboardData?.getData("text");
          if (!options().addOnPaste || !text) return;
          event.preventDefault();
          const delimiter = options().delimiter ?? ",";
          addAll(delimiter ? text.split(delimiter) : [text], { reason: "input-change", event });
        },
        focusout(event, input) {
          highlight(null);
          if (options().addOnBlur && input.value.trim()) {
            if (api.add(input.value, { reason: "input-commit", event })) input.value = "";
          }
        },
      },
    };
    return api;
  },
  slots: (slot) => ({
    root: slot<{}, TagsInputState>({
      state: rootState,
      attrs: rootAttrs,
    }),
    item: slot<TagsInputItemProps, TagsInputItemState>({
      props: { value: "string", disabled: "boolean" },
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { id, props }) => ({
        id: partId(id, "item", props.value),
        "aria-current": state.highlighted === props.value ? "true" : undefined,
        ...itemAttrs(state, props),
      }),
    }),
    "item-text": slot<PartProps, TagsInputItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { id, props }) => ({
        id: partId(id, "item-text", props.value ?? ""),
        ...itemAttrs(state, props),
      }),
    }),
    // Out of the tab order: Backspace and Delete remove tags from the keyboard.
    // Its name is its own content, like "Remove", and the tag's text.
    "item-delete": slot<PartProps, TagsInputItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { id, props }) => {
        const tag = props.value ?? "";
        return {
          type: "button",
          tabindex: "-1",
          id: partId(id, "item-delete", tag),
          "aria-labelledby": `${partId(id, "item-delete", tag)} ${partId(id, "item-text", tag)}`,
          disabled: state.disabled || props.disabled ? "" : undefined,
          ...itemAttrs(state, props),
        };
      },
      press: ({ api, props }, event) => {
        if (props.value !== undefined) api.remove(props.value, { reason: "remove-press", event });
      },
    }),
    input: slot<{}, TagsInputState>({
      state: rootState,
      attrs: (state) => ({
        type: "text",
        autocomplete: "off",
        autocapitalize: "off",
        disabled: state.disabled ? "" : undefined,
        "aria-invalid": state.invalid ? "true" : undefined,
        ...rootAttrs(state),
      }),
      on: {
        keydown: (event, { el, api }) => el && api.internal.keydown(event as KeyboardEvent, el as HTMLInputElement),
        input: (event, { el, api }) => el && api.internal.input(event as InputEvent, el as HTMLInputElement),
        paste: (event, { api }) => api.internal.paste(event as ClipboardEvent),
        focusout: (event, { el, api }) => el && api.internal.focusout(event as FocusEvent, el as HTMLInputElement),
      },
    }),
    clear: slot<{}, TagsInputState>({
      state: rootState,
      attrs: (state) => ({
        type: "button",
        disabled: state.disabled ? "" : undefined,
        ...rootAttrs(state),
      }),
      press: ({ api }, event) => api.clear({ reason: "clear-press", event }),
    }),
    // One per tag, while the root has a `name`.
    "hidden-input": slot<{ value?: string }>({
      props: { value: "string" },
      present: (state) => state.name !== undefined,
      attrs: (state, { props }) => ({
        type: "hidden",
        name: state.name,
        value: props.value,
        form: state.form,
        disabled: state.disabled ? "" : undefined,
      }),
    }),
  }),
});
