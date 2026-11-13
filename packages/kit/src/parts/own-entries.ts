/** The entries the kit adds to ui-sdk's, with the parts each one exports. The Nuxt module registers them. */
export const ownEntries: Record<string, readonly string[]> = {
  editable: [
    "Editable",
    "EditableArea",
    "EditableCancelTrigger",
    "EditableEditTrigger",
    "EditableInput",
    "EditablePreview",
    "EditableSubmitTrigger",
  ],
  form: ["Form"],
  "tag-group": ["TagGroup", "TagGroupItem", "TagGroupItemRemove"],
  "tags-input": [
    "TagsInput",
    "TagsInputClear",
    "TagsInputInput",
    "TagsInputItem",
    "TagsInputItemDelete",
    "TagsInputItemText",
  ],
};
