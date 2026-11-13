import {
  createChange,
  createInlineEdit,
  definePrimitive,
  type ChangeDetails,
  type ChangeOptions,
  type InlineEdit,
  type InlineEditReason,
  type PrimitiveOptions,
  type SlotDefinition,
} from "@ui-sdk/core";

// Editable shows a value as text and turns it into an input in place, with
// `createInlineEdit`: Enter or F2 on the preview starts editing with the text,
// a printable key starts over with that key, Enter or leaving saves, and
// Escape puts the text back. Focus goes back to where editing started.

/**
 * What starts editing: focus on the preview, a double click on it, or only
 * the edit trigger and the keys. Enter and F2 on the preview start editing in
 * every mode but `"none"`.
 */
export type EditableActivationMode = "focus" | "dblclick" | "none";

/** What saves: leaving the input, Enter, both, or only the submit trigger. */
export type EditableSubmitMode = "blur" | "enter" | "both" | "none";

/** Why the value changed, as `reason` in its change details. */
export type EditableValueChangeReason = "enter-key" | "focus-out" | "submit-press" | "imperative";

/** The options `editablePrimitive` takes. A component takes them as props on its root. */
export type EditableOptions = {
  /** The saved text. Bind it with `v-model`. */
  value?: string;
  /** The text it starts with, when you don't control `value`. */
  defaultValue?: string;
  /** Called when an edit is saved with new text. Cancel it to keep editing. */
  onValueChange?: (value: string, details: ChangeDetails<EditableValueChangeReason>) => void;
  /** Shows in the preview while the value is empty, and in the input. */
  placeholder?: string;
  /**
   * What starts editing besides the edit trigger and Enter or F2.
   * @defaultValue "focus"
   */
  activationMode?: EditableActivationMode;
  /**
   * What saves the text. The other ways out cancel.
   * @defaultValue "both"
   */
  submitMode?: EditableSubmitMode;
  /** Whether it starts in edit mode, with focus in the input. */
  defaultEditing?: boolean;
  /** The longest text the input takes. */
  maxLength?: number;
  /** Stops editing, and marks every part. */
  disabled?: boolean;
  /** Shows the value without a way to edit it. */
  readOnly?: boolean;
  /** Whether the input must have text. */
  required?: boolean;
  /** Submits the value with a form under this name, through a hidden input. */
  name?: string;
  /** The id of the form the hidden input belongs to, when it isn't inside it. */
  form?: string;
} & PrimitiveOptions;

/** The state every part of `editablePrimitive` hands `render` functions and state-based class names. */
export type EditableState = {
  /** The saved text. */
  value: string;
  /** Whether the input shows. */
  editing: boolean;
  /** Whether the saved text is empty. */
  empty: boolean;
  /** Shows in the preview while the value is empty. */
  placeholder: string | undefined;
  disabled: boolean;
  readOnly: boolean;
};

type EditableStore = {
  value: string;
  editing: string | null;
  placeholder: string | undefined;
  activationMode: EditableActivationMode;
  submitMode: EditableSubmitMode;
  maxLength: number | undefined;
  disabled: boolean;
  readOnly: boolean;
  required: boolean;
  name: string | undefined;
  form: string | undefined;
};

/** `editablePrimitive`'s api, which its slots call. Adapters expose it as `api`. */
export interface EditableApi {
  /** Starts editing, with focus in the input. */
  edit: () => boolean;
  /** Saves the input's text and stops editing. */
  submit: () => boolean;
  /** Stops editing without saving. */
  cancel: () => void;
  /** Saves new text without editing. */
  setValue: (value: string, details?: ChangeOptions<EditableValueChangeReason>) => boolean;
  internal: {
    inline: InlineEdit;
    focus: () => void;
    dblclick: (event: MouseEvent) => void;
    previewKeydown: (event: KeyboardEvent) => void;
    inputKeydown: (event: KeyboardEvent) => void;
    focusout: (event: FocusEvent, root: HTMLElement) => void;
    submitPress: () => void;
    defaultEditing: () => void;
  };
}

type Slot<Public> = SlotDefinition<EditableStore, EditableApi, { id?: string }, Public>;

type EditableSlots = {
  root: Slot<EditableState>;
  area: Slot<EditableState>;
  preview: Slot<EditableState>;
  input: Slot<EditableState>;
  "submit-trigger": Slot<EditableState>;
  "cancel-trigger": Slot<EditableState>;
  "edit-trigger": Slot<EditableState>;
  "hidden-input": Slot<{}>;
};

/** The type of `editablePrimitive`. */
export interface EditablePrimitive
  extends ReturnType<typeof definePrimitive<EditableOptions, EditableStore, EditableApi, EditableSlots>> {}

// The one id `createInlineEdit` edits.
const item = "value";

const fromOptions = (options: EditableOptions) => ({
  placeholder: options.placeholder,
  activationMode: options.activationMode ?? "focus",
  submitMode: options.submitMode ?? "both",
  maxLength: options.maxLength,
  disabled: !!options.disabled,
  readOnly: !!options.readOnly,
  required: !!options.required,
  name: options.name,
  form: options.form,
});

const editableState = (state: EditableStore): EditableState => ({
  value: state.value,
  editing: state.editing !== null,
  empty: state.value === "",
  placeholder: state.placeholder,
  disabled: state.disabled,
  readOnly: state.readOnly,
});

const dataAttrs = (state: EditableStore) => ({
  "data-editing": state.editing === null ? undefined : "",
  "data-empty": state.value === "" ? "" : undefined,
  "data-disabled": state.disabled ? "" : undefined,
  "data-readonly": state.readOnly ? "" : undefined,
});

const toValueReason = (reason: InlineEditReason): EditableValueChangeReason =>
  reason === "enter-key" || reason === "focus-out" ? reason : "imperative";

/**
 * The editable primitive, with the slots `root`, `area`, `preview`, `input`,
 * `submit-trigger`, `cancel-trigger`, `edit-trigger`, `hidden-input`. Render it with an
 * adapter's `createParts`.
 */
export const editablePrimitive: EditablePrimitive = definePrimitive({
  name: "editable",
  options: {
    value: "string",
    defaultValue: "string",
    onValueChange: "callback",
    placeholder: "string",
    activationMode: "string",
    submitMode: "string",
    defaultEditing: "boolean",
    maxLength: "number",
    disabled: "boolean",
    readOnly: "boolean",
    required: "boolean",
    name: "string",
    form: "string",
  },
  controlled: ["value"],
  state: (options: EditableOptions): EditableStore => ({
    value: options.value ?? options.defaultValue ?? "",
    editing: null,
    ...fromOptions(options),
  }),
  sync: (options) => ({
    ...fromOptions(options),
    ...(options.value === undefined ? {} : { value: options.value }),
  }),
  api: (context): EditableApi => {
    const { store } = context;
    const change = createChange(context);
    let pressed = false;
    // Focus comes back to the preview as editing ends. In focus mode, that
    // focus must not start editing again.
    let returning = false;
    const inline = createInlineEdit(context, {
      key: "editing",
      value: () => store.get().value,
      disabled: () => store.get().disabled || store.get().readOnly,
      commit: (_id, text, { reason, event }) =>
        change("value", text, { reason: pressed ? "submit-press" : toValueReason(reason), event }),
    });
    let editing = store.get().editing;
    context.onDestroy(
      store.subscribe(() => {
        const next = store.get().editing;
        if (editing !== null && next === null) {
          returning = true;
          setTimeout(() => (returning = false));
        }
        editing = next;
      }),
    );
    const submit = () => inline.end("imperative");
    const cancel = () => inline.cancel();

    return {
      edit: () => inline.start(item),
      submit,
      cancel,
      setValue: (value, details = {}) =>
        change("value", value, { reason: details.reason ?? "imperative", event: details.event }),
      internal: {
        inline,
        focus() {
          if (!returning && store.get().activationMode === "focus") inline.start(item);
        },
        dblclick(event) {
          if (store.get().activationMode === "dblclick") inline.dblclick(event, item);
        },
        previewKeydown(event) {
          if (store.get().activationMode !== "none") inline.keydown(event, item);
        },
        inputKeydown(event) {
          // Tab moves on, and leaving saves or cancels.
          if (event.key === "Tab") return;
          const { submitMode } = store.get();
          if (event.key === "Enter" && (submitMode === "blur" || submitMode === "none")) return;
          inline.inputKeydown(event);
        },
        // Leaving the editable, not moving to its own triggers, saves or cancels.
        focusout(event, root) {
          if (store.get().editing === null) return;
          if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
          const { submitMode } = store.get();
          if (submitMode === "blur" || submitMode === "both") inline.end("focus-out", event);
          else inline.cancel();
        },
        submitPress() {
          pressed = true;
          try {
            submit();
          } finally {
            pressed = false;
          }
        },
        defaultEditing() {
          if (context.options().defaultEditing) inline.start(item);
        },
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, EditableState>({
      state: editableState,
      attrs: (state) => dataAttrs(state),
      on: { focusout: (event, { el, api }) => el && api.internal.focusout(event as FocusEvent, el) },
      bind: (_el, { api }) => api.internal.defaultEditing(),
    }),
    area: slot<{}, EditableState>({
      state: editableState,
      attrs: (state) => dataAttrs(state),
    }),
    preview: slot<{}, EditableState>({
      state: editableState,
      attrs: (state) => ({
        tabindex: state.disabled ? undefined : "0",
        hidden: state.editing === null ? undefined : "",
        ...dataAttrs(state),
      }),
      on: {
        focus: (_event, { api }) => api.internal.focus(),
        dblclick: (event, { api }) => api.internal.dblclick(event as MouseEvent),
        keydown: (event, { api }) => api.internal.previewKeydown(event as KeyboardEvent),
      },
    }),
    input: slot<{}, EditableState>({
      present: (state) => state.editing !== null,
      state: editableState,
      attrs: (state) => ({
        placeholder: state.placeholder,
        maxlength: state.maxLength === undefined ? undefined : String(state.maxLength),
        required: state.required ? "" : undefined,
        readonly: state.readOnly ? "" : undefined,
        ...dataAttrs(state),
      }),
      on: { keydown: (event, { api }) => api.internal.inputKeydown(event as KeyboardEvent) },
      bind: (el, { api }) => api.internal.inline.bindInput(el as HTMLInputElement),
    }),
    // Pressing a trigger keeps focus in the input, so leaving it doesn't save first.
    "submit-trigger": slot<{}, EditableState>({
      present: (state) => state.editing !== null,
      state: editableState,
      attrs: (state) => ({ type: "button", ...dataAttrs(state) }),
      press: ({ api }) => api.internal.submitPress(),
      on: { mousedown: (event) => event.preventDefault() },
    }),
    "cancel-trigger": slot<{}, EditableState>({
      present: (state) => state.editing !== null,
      state: editableState,
      attrs: (state) => ({ type: "button", ...dataAttrs(state) }),
      press: ({ api }) => api.cancel(),
      on: { mousedown: (event) => event.preventDefault() },
    }),
    // Hidden, not removed, while editing, so focus can come back to it.
    "edit-trigger": slot<{}, EditableState>({
      state: editableState,
      attrs: (state) => ({
        type: "button",
        hidden: state.editing === null ? undefined : "",
        disabled: state.disabled || state.readOnly ? "" : undefined,
        ...dataAttrs(state),
      }),
      press: ({ api }) => api.edit(),
    }),
    // The value for a form, while the root has a `name`.
    "hidden-input": slot({
      present: (state) => state.name !== undefined,
      attrs: (state) => ({
        type: "hidden",
        name: state.name,
        value: state.value,
        form: state.form,
        disabled: state.disabled ? "" : undefined,
      }),
    }),
  }),
});
