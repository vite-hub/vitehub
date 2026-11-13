import { createParts, usePart, type PartSlots, type Parts } from "@ui-sdk/vue/primitive";
import { defineComponent, h } from "vue";

import { withFormInputs } from "./parts/form-inputs.ts";
import { editablePrimitive, type EditablePrimitive, type EditableState } from "./primitives/editable.ts";

type EditableTags = {
  root: "div";
  area: "div";
  preview: "span";
  input: "input";
  "submit-trigger": "button";
  "cancel-trigger": "button";
  "edit-trigger": "button";
  "hidden-input": "input";
};
type EditableParts = Parts<EditablePrimitive, EditableTags>;

const parts: EditableParts = createParts(editablePrimitive, {
  root: "div",
  area: "div",
  preview: "span",
  input: "input",
  "submit-trigger": "button",
  "cancel-trigger": "button",
  "edit-trigger": "button",
  "hidden-input": "input",
});

/**
 * Text that turns into an input in place. `v-model` binds the saved text.
 * Focus or a double click on the preview starts editing, as `activation-mode`
 * says, and so do Enter and F2. Enter or leaving saves, as `submit-mode` says,
 * and Escape cancels. With `name`, a form submits the value.
 */
export const Editable: EditableParts["Root"] = withFormInputs(parts.Root, (_state: EditableState) => [
  h(parts.HiddenInput),
]);

/** Holds the preview and the input, which take the same place. */
export const EditableArea: EditableParts["Area"] = parts.Area;

/**
 * The saved text, or the placeholder while it's empty, hidden while editing.
 * It takes focus, and Enter, F2, or typing starts editing.
 */
// SAFETY: a hand-written part with no props of its own, like `createParts`' preview, so it has the same type.
export const EditablePreview: EditableParts["Preview"] = defineComponent({
  name: "EditablePreview",
  inheritAttrs: false,
  slots: Object as PartSlots<EditablePrimitive, "preview">,
  setup(_props, { slots }) {
    return usePart(editablePrimitive, "preview", undefined, undefined, {
      tag: "span",
      children: (state: EditableState) => (slots.default ? slots.default({ state }) : state.value || state.placeholder),
    });
  },
}) as unknown as EditableParts["Preview"];

/** The input, while editing. It starts with the text selected, or with the key that started editing. */
export const EditableInput: EditableParts["Input"] = parts.Input;

/** Saves the text, while editing. */
export const EditableSubmitTrigger: EditableParts["SubmitTrigger"] = parts.SubmitTrigger;

/** Stops editing without saving. */
export const EditableCancelTrigger: EditableParts["CancelTrigger"] = parts.CancelTrigger;

/** Starts editing. Hidden while editing, and focus comes back to it after. */
export const EditableEditTrigger: EditableParts["EditTrigger"] = parts.EditTrigger;

export { editablePrimitive };
export type {
  EditableActivationMode,
  EditableApi,
  EditableOptions,
  EditablePrimitive,
  EditableState,
  EditableSubmitMode,
  EditableValueChangeReason,
} from "./primitives/editable.ts";
