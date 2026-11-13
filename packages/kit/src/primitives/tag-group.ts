import {
  createChange,
  createRovingFocus,
  definePrimitive,
  dispatch,
  type ChangeDetails,
  type ChangeOptions,
  type PrimitiveOptions,
  type RovingFocus,
  type SlotDefinition,
} from "@ui-sdk/core";

// Tag Group is a list of tags a person can select and remove, as in React Aria.
// It's a grid of one row per tag, with one tab stop: the arrow keys, Home and
// End move between tags, Space or Enter selects one, and Delete or Backspace
// removes one that has a remove button.

/** How many tags can be selected: none, one, or any number. */
export type TagGroupSelectionMode = "none" | "single" | "multiple";

/** Why the selection changed, as `reason` in its change details. */
export type TagGroupValueChangeReason = "item-press" | "imperative";

/** Why tags were removed, as `reason` in the details of `onRemove`. */
export type TagGroupRemoveReason = "remove-press" | "remove-key" | "imperative";

/** The options `tagGroupPrimitive` takes. A component takes them as props on its root. */
export type TagGroupOptions = {
  /** The values of the selected tags. Bind it with `v-model`. */
  value?: string[];
  /** The tags selected at first, when you don't control `value`. */
  defaultValue?: string[];
  /** Called when the selection changes. */
  onValueChange?: (value: string[], details: ChangeDetails<TagGroupValueChangeReason>) => void;
  /**
   * How many tags can be selected.
   * @defaultValue "none"
   */
  selectionMode?: TagGroupSelectionMode;
  /**
   * Called with the values of the tags to remove, from a remove button or
   * Delete and Backspace. Remove them from your list.
   */
  onRemove?: (values: string[], details: ChangeDetails<TagGroupRemoveReason>) => void;
  /** Stops selecting and removing tags, and marks every part. */
  disabled?: boolean;
} & PrimitiveOptions;

/** The props the `item` slot of `tagGroupPrimitive` takes. */
export type TagGroupItemProps = {
  /** The tag's value, which the selection holds. */
  value: string;
  /** Whether the tag can't be selected or removed. It can still take focus. */
  disabled?: boolean;
};

/** The props the `item-remove` slot of `tagGroupPrimitive` takes. */
export type TagGroupItemRemoveProps = {
  /** The value of the tag it removes. Its item passes it. */
  value?: string;
  /** Whether its tag is disabled. Its item passes it. */
  disabled?: boolean;
};

/** The state the `root` slot of `tagGroupPrimitive` hands `render` functions and state-based class names. */
export type TagGroupState = {
  /** The values of the selected tags. */
  value: string[];
  selectionMode: TagGroupSelectionMode;
  disabled: boolean;
};

/** The state the `item` and `item-remove` slots of `tagGroupPrimitive` hand `render` functions and state-based class names. */
export type TagGroupItemState = {
  /** The tag's value. */
  value: string;
  /** Whether the tag is selected. */
  selected: boolean;
  disabled: boolean;
};

type TagGroupStore = {
  value: string[];
  stop: string | null;
  removable: string[];
  selectionMode: TagGroupSelectionMode;
  disabled: boolean;
};

/** `tagGroupPrimitive`'s api, which its slots call. Adapters expose it as `api`. */
export interface TagGroupApi {
  /** Selects these tags. */
  setValue: (value: string[], details?: ChangeOptions<TagGroupValueChangeReason>) => boolean;
  /** Asks to remove tags through `onRemove`. Returns false when it's disabled or canceled. */
  remove: (values: string[], details?: ChangeOptions<TagGroupRemoveReason>) => boolean;
  /** Moves focus to a tag, or to the one with the tab stop. */
  focus: (value?: string) => void;
  internal: {
    roving: RovingFocus;
    press: (value: string, event: Event) => void;
    keydown: (event: KeyboardEvent, el: HTMLElement, value: string) => void;
    removable: (value: string) => () => void;
  };
}

type Slot<Props, Public> = SlotDefinition<TagGroupStore, TagGroupApi, Props & { id?: string }, Public>;

type TagGroupSlots = {
  root: Slot<{}, TagGroupState>;
  item: Slot<TagGroupItemProps, TagGroupItemState>;
  "item-remove": Slot<TagGroupItemRemoveProps, TagGroupItemState>;
};

/** The type of `tagGroupPrimitive`. */
export interface TagGroupPrimitive
  extends ReturnType<typeof definePrimitive<TagGroupOptions, TagGroupStore, TagGroupApi, TagGroupSlots>> {}

const fromOptions = (options: TagGroupOptions) => ({
  selectionMode: options.selectionMode ?? "none",
  disabled: !!options.disabled,
});

const itemState = (state: TagGroupStore, props: TagGroupItemRemoveProps): TagGroupItemState => ({
  value: props.value ?? "",
  selected: props.value !== undefined && state.value.includes(props.value),
  disabled: state.disabled || !!props.disabled,
});

const itemAttrs = (state: TagGroupStore, props: TagGroupItemRemoveProps) => {
  const item = itemState(state, props);
  return {
    "data-selected": item.selected ? "" : undefined,
    "data-disabled": item.disabled ? "" : undefined,
  };
};

/**
 * The tag group primitive, with the slots `root`, `item`, `item-remove`.
 * Render it with an adapter's `createParts` or `usePart`.
 */
export const tagGroupPrimitive: TagGroupPrimitive = definePrimitive({
  name: "tag-group",
  options: {
    value: "list",
    defaultValue: "list",
    onValueChange: "callback",
    selectionMode: "string",
    onRemove: "callback",
    disabled: "boolean",
  },
  controlled: ["value"],
  state: (options: TagGroupOptions): TagGroupStore => ({
    value: options.value ?? options.defaultValue ?? [],
    stop: null,
    removable: [],
    ...fromOptions(options),
  }),
  sync: (options) => ({
    ...fromOptions(options),
    ...(options.value === undefined ? {} : { value: options.value }),
  }),
  api: (context): TagGroupApi => {
    const { store } = context;
    const change = createChange(context);
    const itemDisabled = (value: string) =>
      store.get().disabled || !!context.props<{ disabled?: boolean }>("item", value)?.disabled;
    const roving = createRovingFocus<TagGroupStore, TagGroupItemProps>(context, {
      slot: "item",
      key: "stop",
      orientation: () => "both",
      disabled: (item) => itemDisabled(item.key),
    });

    const api: TagGroupApi = {
      setValue: (value, details = {}) =>
        change("value", value, { reason: details.reason ?? "imperative", event: details.event }),
      remove(values, details = {}) {
        const removable = values.filter((value) => !itemDisabled(value));
        if (!removable.length) return false;
        const items = roving.items();
        const active = items.find((item) => item.el.contains(item.el.ownerDocument.activeElement));
        const canceled = dispatch(context, "onRemove", removable, {
          reason: details.reason ?? "imperative",
          event: details.event,
        });
        if (canceled) return false;
        // Focus goes to the tag after the removed one, or the one before, once it leaves the page.
        if (active && removable.includes(active.key)) {
          const index = items.indexOf(active);
          const rest = (list: typeof items) => list.find((item) => !removable.includes(item.key));
          const next = rest(items.slice(index + 1)) ?? rest(items.slice(0, index).reverse());
          setTimeout(() => {
            if (next && !active.el.isConnected) roving.focus(next.key);
          });
        }
        return true;
      },
      focus: (value) => roving.focus(value),
      internal: {
        roving,
        press(value, event) {
          const { selectionMode, value: selected } = store.get();
          if (selectionMode === "none" || itemDisabled(value)) return;
          const has = selected.includes(value);
          const next =
            selectionMode === "single"
              ? has
                ? []
                : [value]
              : has
                ? selected.filter((item) => item !== value)
                : [...selected, value];
          change("value", next, { reason: "item-press", event });
        },
        keydown(event, el, value) {
          // Keys pressed on a button inside the tag are the button's.
          if (event.defaultPrevented || event.target !== el) return;
          if (roving.keydown(event, el)) return;
          if ((event.key === "Delete" || event.key === "Backspace") && store.get().removable.includes(value)) {
            event.preventDefault();
            api.remove([value], { reason: "remove-key", event });
            return;
          }
          if ((event.key === " " || event.key === "Enter") && store.get().selectionMode !== "none") {
            event.preventDefault();
            api.internal.press(value, event);
          }
        },
        // A tag with a remove button in the page can be removed with Delete and Backspace too.
        removable(value) {
          store.set({ removable: [...store.get().removable, value] });
          return () => {
            const removable = [...store.get().removable];
            removable.splice(removable.indexOf(value), 1);
            store.set({ removable });
          };
        },
      },
    };
    return api;
  },
  slots: (slot) => ({
    root: slot<{}, TagGroupState>({
      role: "grid",
      keys: { none: "Each tag handles its own keys." },
      state: (state) => ({ value: state.value, selectionMode: state.selectionMode, disabled: state.disabled }),
      attrs: (state) => ({
        "aria-multiselectable": state.selectionMode === "multiple" ? "true" : undefined,
        "data-disabled": state.disabled ? "" : undefined,
      }),
    }),
    item: slot<TagGroupItemProps, TagGroupItemState>({
      role: "row",
      props: { value: "string", disabled: "boolean" },
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { key, props, api }) => ({
        tabindex: api.internal.roving.tabIndex(state, { key, props }),
        "aria-selected":
          state.selectionMode === "none" ? undefined : String(state.value.includes(props.value)),
        "aria-disabled": state.disabled || props.disabled ? "true" : undefined,
        ...itemAttrs(state, props),
      }),
      on: {
        keydown: (event, { el, key, api }) => el && api.internal.keydown(event as KeyboardEvent, el, key),
        // A press on the remove button removes the tag, and doesn't select it.
        click: (event, { key, api }) => {
          if (event.target instanceof Element && event.target.closest('[data-slot="tag-group-item-remove"]')) return;
          api.internal.press(key, event);
        },
      },
      bind: (el, part) => part.api.internal.roving.bind(el, part),
    }),
    // Out of the tab order, since Delete and Backspace remove the focused tag.
    "item-remove": slot<TagGroupItemRemoveProps, TagGroupItemState>({
      props: { value: "string", disabled: "boolean" },
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { props }) => ({
        type: "button",
        tabindex: "-1",
        disabled: state.disabled || props.disabled ? "" : undefined,
        ...itemAttrs(state, props),
      }),
      press: ({ api, props }, event) => {
        if (props.value !== undefined) api.remove([props.value], { reason: "remove-press", event });
      },
      bind: (_el, { api, props }) => (props.value === undefined ? undefined : api.internal.removable(props.value)),
    }),
  }),
});
