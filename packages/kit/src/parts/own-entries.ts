/** The entries the kit adds to ui-sdk's, with the parts each one exports. The Nuxt module registers them. */
export const ownEntries: Record<string, readonly string[]> = {
  "tags-input": [
    "TagsInput",
    "TagsInputClear",
    "TagsInputInput",
    "TagsInputItem",
    "TagsInputItemDelete",
    "TagsInputItemText",
  ],
};
