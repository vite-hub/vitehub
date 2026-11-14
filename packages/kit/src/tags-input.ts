import { createParts, type Parts } from "@ui-sdk/vue/primitive";
import { h } from "vue";

import { withFormInputs } from "./parts/form-inputs.ts";
import { tagsInputPrimitive, type TagsInputPrimitive, type TagsInputState } from "./primitives/tags-input.ts";

type TagsInputTags = {
  root: "div";
  item: "span";
  "item-text": "span";
  "item-delete": "button";
  input: "input";
  clear: "button";
  "hidden-input": "input";
};
type TagsInputParts = Parts<TagsInputPrimitive, TagsInputTags>;

const parts: TagsInputParts = createParts(tagsInputPrimitive, {
  root: "div",
  item: "span",
  "item-text": "span",
  "item-delete": "button",
  input: "input",
  clear: "button",
  "hidden-input": "input",
});

/**
 * Free text as a list of tags. `v-model` binds the tags. Enter or the
 * `delimiter` adds the typed text, Backspace in an empty input removes the
 * last tag, and the arrow keys highlight tags. With `name`, a form submits
 * each tag.
 */
export const TagsInput: TagsInputParts["Root"] = withFormInputs(parts.Root, (state: TagsInputState) =>
  state.value.map((tag) => h(parts.HiddenInput, { key: tag, value: tag })),
);

/** One tag. Pass its `value`. It shows `data-highlighted` while the arrow keys are on it. */
export const TagsInputItem: TagsInputParts["Item"] = parts.Item;

/** The tag's text, which also names its delete button. */
export const TagsInputItemText: TagsInputParts["ItemText"] = parts.ItemText;

/** Removes its tag. Out of the tab order, since Backspace and Delete do the same from the input. */
export const TagsInputItemDelete: TagsInputParts["ItemDelete"] = parts.ItemDelete;

/** Where the person types new tags. */
export const TagsInputInput: TagsInputParts["Input"] = parts.Input;

/** Removes every tag. */
export const TagsInputClear: TagsInputParts["Clear"] = parts.Clear;

export { tagsInputPrimitive };
export type {
  TagsInputApi,
  TagsInputItemProps,
  TagsInputItemState,
  TagsInputOptions,
  TagsInputPrimitive,
  TagsInputState,
  TagsInputValueChangeReason,
} from "./primitives/tags-input.ts";
