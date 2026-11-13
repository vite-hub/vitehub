import { createParts, usePart, type PartSlots, type Parts } from "@ui-sdk/vue/primitive";
import { defineComponent, h, inject, provide, type InjectionKey } from "vue";

import {
  tagGroupPrimitive,
  type TagGroupItemProps,
  type TagGroupItemState,
  type TagGroupPrimitive,
} from "./primitives/tag-group.ts";

type TagGroupTags = { root: "div"; item: "div"; "item-remove": "button" };
type TagGroupParts = Parts<TagGroupPrimitive, TagGroupTags>;

const parts: Parts<TagGroupPrimitive, { root: "div" }> = createParts(tagGroupPrimitive, { root: "div" });

// The item's props, for the remove button inside it. `createParts` shares
// them through a helper ui-sdk does not export, so the two parts share them here.
const ItemKey: InjectionKey<() => TagGroupItemProps> = Symbol("tag-group-item");

/**
 * A list of tags, which a person can select and remove. Name it with
 * `aria-label`. `v-model` binds the selected values, as `selection-mode`
 * allows, and `@remove` gets the values to remove.
 */
export const TagGroup: TagGroupParts["Root"] = parts.Root;

/**
 * One tag. Pass its `value`. It's a row of the grid, and its content sits in
 * the row's one cell, which has `data-slot="tag-group-item-cell"`.
 */
// SAFETY: a hand-written part with the props of the `item` slot, like `createParts`' item, so it has the same type.
export const TagGroupItem: TagGroupParts["Item"] = defineComponent({
  name: "TagGroupItem",
  inheritAttrs: false,
  props: {
    value: { type: String, required: true },
    disabled: { type: Boolean, default: undefined },
  },
  slots: Object as PartSlots<TagGroupPrimitive, "item">,
  setup(props, { slots }) {
    const item = () => ({ value: props.value, disabled: props.disabled });
    provide(ItemKey, item);
    return usePart(tagGroupPrimitive, "item", item, undefined, {
      tag: "div",
      children: (state: TagGroupItemState) =>
        h("div", { role: "gridcell", "data-slot": "tag-group-item-cell" }, slots.default?.({ state })),
    });
  },
}) as unknown as TagGroupParts["Item"];

/** Removes its tag. Out of the tab order, since Delete and Backspace remove the focused tag. */
// SAFETY: a hand-written part that takes its props from its item, like a `createParts` part does, so it has the same type.
export const TagGroupItemRemove: TagGroupParts["ItemRemove"] = defineComponent({
  name: "TagGroupItemRemove",
  inheritAttrs: false,
  slots: Object as PartSlots<TagGroupPrimitive, "item-remove">,
  setup() {
    const item = inject(ItemKey, null);
    if (!item) throw new Error("<TagGroupItemRemove> must be used inside <TagGroupItem>.");
    return usePart(tagGroupPrimitive, "item-remove", item, undefined, "button");
  },
}) as unknown as TagGroupParts["ItemRemove"];

export { tagGroupPrimitive };
export type {
  TagGroupApi,
  TagGroupItemProps,
  TagGroupItemRemoveProps,
  TagGroupItemState,
  TagGroupOptions,
  TagGroupPrimitive,
  TagGroupRemoveReason,
  TagGroupSelectionMode,
  TagGroupState,
  TagGroupValueChangeReason,
} from "./primitives/tag-group.ts";
