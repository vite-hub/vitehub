import { flip, offset, shift } from "@floating-ui/dom";
import type { Editor, JSONContent } from "@tiptap/core";
import DragHandle from "@tiptap/extension-drag-handle-vue-3";
import type { PluginKey, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { BubbleMenu as TiptapBubbleMenu } from "@tiptap/vue-3/menus";
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuItemIcon, MenuSeparator, MenuTrigger } from "@ui-sdk/vue/menu";
import { Toggle, ToggleIcon } from "@ui-sdk/vue/toggle";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@ui-sdk/vue/toolbar";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@ui-sdk/vue/tooltip";
import {
  type TextEditorAdapter,
  TriggerMenu,
  TriggerMenuContent,
  TriggerMenuGroup,
  TriggerMenuGroupLabel,
  TriggerMenuItem,
  TriggerMenuItemIcon,
  TriggerMenuList,
  TriggerMenuSeparator,
  TriggerMenuStatus,
} from "@ui-sdk/vue/trigger-menu";
import { type Component, computed, defineComponent, h, inject, onMounted, type PropType, type Ref, ref, shallowRef, type VNode } from "vue";

import { useViteHubUIIcons } from "../config.ts";
import { createEditorHandlers, type EditorHandlers, editorHandlersKey, type EditorItem } from "../editor/handlers.ts";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/**
 * The editor parts on ui-sdk: Nuxt UI's `UEditorToolbar`, `UEditorSuggestionMenu`, and `UEditorDragHandle`, with the
 * props, slots, and events that ViteHub's editors use. Positioning at the selection and the block, and dragging blocks,
 * stay with Tiptap's own menu plugins. They run items through the handlers that the editor provides under
 * `editorHandlersKey`, as Nuxt UI's do.
 */

// The parts take ui-sdk's parts and the seam's components with the props they forward, so they are typed as any component.
const ToggleButton: Component = Toggle;
const ToggleButtonIcon: Component = ToggleIcon;
const Bar: Component = Toolbar;
const BarButton: Component = ToolbarButton;
const BarGroup: Component = ToolbarGroup;
const BarSeparator: Component = ToolbarSeparator;
const Tip: Component = Tooltip;
const TipTrigger: Component = TooltipTrigger;
const TipContent: Component = TooltipContent;
const TipShortcut: Component = TooltipShortcut;
const DropdownMenu: Component = Menu;
const DropdownTrigger: Component = MenuTrigger;
const DropdownContent: Component = MenuContent;
const DropdownItem: Component = MenuItem;
const SlashMenu: Component = TriggerMenu;
const SlashContent: Component = TriggerMenuContent;
const SlashList: Component = TriggerMenuList;
const SlashItem: Component = TriggerMenuItem;
const SlashStatus: Component = TriggerMenuStatus;
const BlockHandle: Component = DragHandle;
const BubbleMenu: Component = TiptapBubbleMenu;

function useHandlers(): Ref<EditorHandlers> {
  return inject<Ref<EditorHandlers>>(editorHandlersKey, computed(createEditorHandlers), true);
}

const isGroups = <T>(items: T[] | T[][]): items is T[][] => items.length > 0 && Array.isArray(items[0]);
const groupsOf = <T>(items: T[] | T[][] | undefined): T[][] => (!items?.length ? [] : isGroups(items) ? items : [items]);

/** A tooltip as Nuxt UI's toolbar items take it: its text, and its keys, such as `["meta", "b"]`. */
export interface EditorToolbarTooltip { text?: string, kbds?: string[] }

/** A dropdown entry of a toolbar item: an editor item, a label, or a separator. */
export type EditorToolbarMenuEntry = EditorItem & {
  type?: "label" | "separator";
  label?: string;
  icon?: string;
  disabled?: boolean;
  onSelect?: (event: Event) => void;
};

/** A toolbar item: an editor item, a button with `onClick`, a dropdown with `items`, or a named slot with `slot`. */
export type EditorToolbarItem = EditorItem & {
  "aria-label"?: string;
  label?: string;
  icon?: string;
  trailingIcon?: string;
  tooltip?: EditorToolbarTooltip;
  slot?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: ((event: MouseEvent) => void) | Array<(event: MouseEvent) => void>;
  items?: EditorToolbarMenuEntry[] | EditorToolbarMenuEntry[][];
  content?: { align?: "start" | "center" | "end", side?: "top" | "right" | "bottom" | "left", sideOffset?: number };
  ui?: { content?: string };
};

// Nuxt UI writes keys by name. ui-sdk reads `mod` as Command on Apple platforms and Control elsewhere.
const shortcutOf = (kbds: string[] | undefined): string | undefined => kbds?.length ? kbds.map(key => (key === "meta" ? "mod" : key)).join("+") : undefined;

/** Nuxt UI's `UEditorToolbar`, in its `fixed` and `bubble` layouts, on ui-sdk's `Toolbar`, `Toggle`, and `Menu`. */
export const UEditorToolbar = defineComponent({
  name: "UEditorToolbar",
  inheritAttrs: false,
  props: {
    editor: { required: true, type: Object as PropType<Editor> },
    items: { default: () => [], type: Array as PropType<EditorToolbarItem[] | EditorToolbarItem[][]> },
    layout: { default: "fixed", type: String as PropType<"bubble" | "fixed"> },
    size: { default: "sm", type: String },
    /** For the `bubble` layout, as Tiptap's `BubbleMenu` takes them. */
    appendTo: { default: undefined, type: [Object, Function] as PropType<HTMLElement | (() => HTMLElement)> },
    getReferencedVirtualElement: { default: undefined, type: Function as PropType<() => { getBoundingClientRect: () => DOMRect } | null> },
    options: { default: undefined, type: Object as PropType<Record<string, unknown>> },
    pluginKey: { default: undefined, type: [String, Object] as PropType<string | PluginKey> },
    resizeDelay: { default: undefined, type: Number },
    shouldShow: { default: undefined, type: Function as PropType<(props: { editor: Editor, state: Editor["state"], view: Editor["view"], from: number, to: number }) => boolean> },
    updateDelay: { default: undefined, type: Number },
    ui: { default: () => ({}), type: Object as PropType<{ root?: string, base?: string, group?: string, separator?: string }> },
  },
  setup(props, { attrs, slots }) {
    const UIcon = useUIComponent("UIcon");
    const handlers = useHandlers();
    const icons = useViteHubUIIcons();

    const isActive = (item: EditorToolbarItem | EditorToolbarMenuEntry): boolean => {
      if (!props.editor.isEditable) return false;
      if ("items" in item && item.items?.length) return groupsOf(item.items).flat().some(isActive);
      if (!item.kind) return ("active" in item && item.active) || false;
      return handlers.value[item.kind]?.isActive(props.editor, item) ?? false;
    };
    const isDisabled = (item: EditorToolbarItem | EditorToolbarMenuEntry): boolean => {
      if (!props.editor.isEditable) return true;
      if ("items" in item && item.items?.length) {
        const actionable = groupsOf(item.items).flat().filter(entry => entry.type !== "separator" && entry.type !== "label");
        return !actionable.length || actionable.every(isDisabled);
      }
      if (!item.kind) return item.disabled ?? false;
      const handler = handlers.value[item.kind];
      if (!handler) return false;
      return Boolean(handler.isDisabled?.(props.editor, item)) || !handler.canExecute(props.editor, item);
    };
    const onClick = (event: MouseEvent | Event, item: EditorToolbarItem | EditorToolbarMenuEntry): void => {
      if (!props.editor.isEditable || isDisabled(item)) return;
      if (!item.kind || ("items" in item && item.items)) {
        if ("onClick" in item && item.onClick) for (const run of [item.onClick].flat()) run(event as MouseEvent);
        return;
      }
      handlers.value[item.kind]?.execute(props.editor, item).run();
    };

    const content = (item: EditorToolbarItem) => {
      const child = item.items ? groupsOf(item.items).flat().find(entry => entry.kind && isActive(entry)) : undefined;
      const icon = child?.icon ?? item.icon;
      const label = item.label !== undefined && child?.label ? child.label : item.label;
      return [
        icon ? h(ToggleButtonIcon, () => h(UIcon, { name: icon })) : null,
        label ? h("span", { "data-slot": "editor-toolbar-label" }, label) : null,
        item.trailingIcon ? h(UIcon, { "data-slot": "editor-toolbar-trailing-icon", name: item.trailingIcon }) : null,
      ];
    };
    const named = (item: EditorToolbarItem) => ({ "aria-label": item["aria-label"] ?? (item.label ? undefined : item.tooltip?.text) });

    // A tooltip renders its trigger through the control, so the control keeps its own role and state.
    const withTooltip = (item: EditorToolbarItem, control: (trigger: Record<string, unknown>) => VNode): VNode => {
      if (!item.tooltip?.text) return control({});
      const shortcut = shortcutOf(item.tooltip.kbds);
      return h(Tip, { disabled: isDisabled(item), shortcut, type: "description" }, () => [
        h(TipTrigger, null, { render: ({ props: trigger }: { props: Record<string, unknown> }) => control(trigger) }),
        h(TipContent, { sideOffset: 6 }, () => [item.tooltip?.text, shortcut ? h(TipShortcut) : null]),
      ]);
    };

    const menuEntry = (entry: EditorToolbarMenuEntry, index: number) => {
      if (entry.type === "label") return h(MenuGroupLabel, { key: index }, () => entry.label);
      if (entry.type === "separator") return h(MenuSeparator, { key: index });
      const active = Boolean(entry.kind) && isActive(entry);
      return h(DropdownItem, {
        "data-active": active ? "" : undefined,
        disabled: isDisabled(entry),
        key: index,
        label: entry.label,
        onSelect: (event: Event) => (entry.kind ? onClick(event, entry) : entry.onSelect?.(event)),
      }, () => [
        entry.icon ? h(MenuItemIcon, () => h(UIcon, { name: entry.icon })) : null,
        h("span", entry.label),
        active ? h(UIcon, { "data-slot": "editor-toolbar-check", name: icons.value.check }) : null,
      ]);
    };

    const control = (item: EditorToolbarItem, index: number): VNode | VNode[] | undefined => {
      const slot = slots[item.slot ?? "item"];
      if (slot) return slot({ index, isActive, isDisabled, item, onClick });
      const data = { "data-size": props.size, key: index };
      if (item.items?.length) {
        const groups = groupsOf(item.items);
        return h(DropdownMenu, { key: index }, () => [
          withTooltip(item, trigger => h(BarButton, { ...data, disabled: isDisabled(item) }, {
            render: ({ props: button }: { props: Record<string, unknown> }) => h(DropdownTrigger, { ...trigger, ...button, ...named(item), "data-active": isActive(item) ? "" : undefined, "data-slot": "toggle" }, () => content(item)),
          })),
          h(DropdownContent, { align: item.content?.align ?? "start", class: item.ui?.content, side: item.content?.side, sideOffset: item.content?.sideOffset ?? 8 }, () => groups.flatMap((group, groupIndex) => [
            groupIndex ? h(MenuSeparator, { key: `separator-${groupIndex}` }) : null,
            h(MenuGroup, { key: `group-${groupIndex}` }, () => group.map(menuEntry)),
          ])),
        ]);
      }
      if (item.kind) {
        return withTooltip(item, trigger => h(ToggleButton, {
          ...trigger,
          ...data,
          ...named(item),
          disabled: isDisabled(item),
          pressed: isActive(item),
          // The editor decides what is pressed. A press runs the item, and the editor's new state shows it.
          onPressedChange: (_pressed: boolean, details: { event?: Event }) => onClick(details.event ?? new Event("click"), item),
        }, () => content(item)));
      }
      return withTooltip(item, trigger => h(BarButton, {
        ...trigger,
        ...data,
        ...named(item),
        "data-active": isActive(item) ? "" : undefined,
        "data-slot": "toggle",
        disabled: isDisabled(item),
        onClick: (event: MouseEvent) => onClick(event, item),
      }, () => content(item)));
    };

    return () => {
      // Read the state here, so the toolbar renders again as the selection moves and its items change state.
      void props.editor.state;
      const groups = groupsOf(props.items);
      const { class: baseClass, ...rootAttrs } = attrs;
      const bar = h(Bar, {
        "aria-label": "Formatting",
        ...(props.layout === "fixed" ? rootAttrs : {}),
        class: ["vh-editor-toolbar", props.ui.base, baseClass],
        "data-layout": props.layout,
      }, () => groups.flatMap((group, groupIndex) => [
        h(BarGroup, { class: props.ui.group, key: `group-${groupIndex}` }, () => group.map(control)),
        groupIndex < groups.length - 1 ? h(BarSeparator, { class: props.ui.separator, key: `separator-${groupIndex}` }) : null,
      ]));
      if (props.layout !== "bubble") return bar;
      return h(BubbleMenu, {
        ...rootAttrs,
        appendTo: props.appendTo,
        class: ["vh-editor-toolbar-root", props.ui.root],
        editor: props.editor,
        getReferencedVirtualElement: props.getReferencedVirtualElement,
        options: { offset: 8, shift: { padding: 8 }, ...props.options },
        pluginKey: props.pluginKey,
        resizeDelay: props.resizeDelay,
        shouldShow: props.shouldShow ?? null,
        tabindex: -1,
        updateDelay: props.updateDelay,
      }, () => bar);
    };
  },
});

/** An entry of the "/" menu: an editor item with a label, or a label or separator between them. */
export type EditorSuggestionMenuItem = EditorItem & {
  type?: "label" | "separator";
  label?: string;
  description?: string;
  icon?: string;
  disabled?: boolean;
  keywords?: string[];
  class?: string;
};

// Nuxt UI's ranking: 0 for a match of the whole text, 1 for a prefix, 2 for any other part, and nothing for no match.
// Case and accents do not count.
const collator = new Intl.Collator(undefined, { sensitivity: "base", usage: "search" });
function contains(value: string, part: string): boolean {
  if (!part) return true;
  const text = value.normalize("NFC");
  const search = part.normalize("NFC");
  for (let index = 0; index + search.length <= text.length; index++) {
    if (collator.compare(text.slice(index, index + search.length), search) === 0) return true;
  }
  return false;
}
function score(value: string, query: string): number | undefined {
  if (!contains(value, query)) return undefined;
  if (contains(query, value)) return 0;
  if (collator.compare(value.slice(0, query.length), query) === 0) return 1;
  return 2;
}
function rank(items: EditorSuggestionMenuItem[], query: string, fields: string[]): EditorSuggestionMenuItem[] {
  if (!query) return items;
  const scored: Array<{ item: EditorSuggestionMenuItem, score: number }> = [];
  for (const item of items) {
    let best: number | undefined;
    for (const field of fields) {
      const value = (item as Record<string, unknown>)[field];
      if (value == null) continue;
      for (const text of [value].flat().map(String)) {
        const found = Math.min(score(text, query) ?? 3, score(text.replace(/[\s_-]/g, ""), query) ?? 3);
        if (best === undefined || found < best) best = found;
      }
    }
    if (best !== undefined && best < 3) scored.push({ item, score: best });
  }
  return scored.sort((a, b) => a.score - b.score).map(({ item }) => item);
}

// An inline node, such as an image, reads as one object replacement character, as ui-sdk reads a token.
const OBJECT = "\uFFFC";

const choosable = (item: EditorSuggestionMenuItem) => item.type !== "label" && item.type !== "separator";

/**
 * The editor as ui-sdk's `TriggerMenu` reads it. Offsets are document positions. The text before the caret is the text
 * of its block, after a line break that stands for the block's start, so a trigger at the start of a block matches as
 * one after a space does.
 */
function tiptapAdapter(editor: Editor): TextEditorAdapter {
  return {
    get element() {
      return editor.isDestroyed ? undefined : editor.view.dom;
    },
    textBefore(length) {
      const { $head } = editor.state.selection;
      if (!$head.parent.isTextblock) return null;
      const from = Math.max(0, $head.parentOffset - length);
      const text = $head.parent.textBetween(from, $head.parentOffset, undefined, OBJECT);
      return from === 0 && text.length < length ? { offset: $head.start() - 1, text: `\n${text}` } : { offset: $head.start() + from, text };
    },
    selection() {
      if (editor.isDestroyed || !editor.view.hasFocus()) return null;
      const { from, to } = editor.state.selection;
      return { end: to, start: from };
    },
    rectAt(offset) {
      try {
        const rect = editor.view.coordsAtPos(offset);
        return { height: rect.bottom - rect.top, width: Math.max(0, rect.right - rect.left), x: rect.left, y: rect.top };
      }
      catch {
        return null;
      }
    },
    replace(range, content) {
      editor.chain().focus().insertContentAt({ from: range.start, to: range.end }, typeof content === "string" ? content : content.label ?? "").run();
    },
    subscribe(listener) {
      const onTransaction = ({ transaction }: { transaction: Transaction }) => {
        if (!transaction.docChanged) {
          if (transaction.selectionSet) listener({ type: "selection" });
          return;
        }
        // A collaborator's edit never opens the menu. A command's does, such as the "/" that a block's "+" inserts.
        const user = !transaction.getMeta("y-sync$");
        for (const step of transaction.steps) {
          if (!(step instanceof ReplaceStep)) continue;
          const inserted = step.slice.content.textBetween(0, step.slice.content.size, "\n", OBJECT);
          listener({ inserted, range: { end: step.to, start: step.from }, type: "input", user });
        }
      };
      const onComposition = (event: CompositionEvent) => listener({ type: event.type === "compositionstart" ? "compositionstart" : "compositionend" });
      editor.on("transaction", onTransaction);
      editor.view.dom.addEventListener("compositionstart", onComposition);
      editor.view.dom.addEventListener("compositionend", onComposition);
      return () => {
        editor.off("transaction", onTransaction);
        if (!editor.isDestroyed) {
          editor.view.dom.removeEventListener("compositionstart", onComposition);
          editor.view.dom.removeEventListener("compositionend", onComposition);
        }
      };
    },
    composing: () => editor.view.composing,
  };
}

/**
 * Nuxt UI's `UEditorSuggestionMenu` on ui-sdk's `TriggerMenu`. Typing `char` opens a list at the caret, the text after
 * it filters `items` with Nuxt UI's ranking, the arrow keys move the highlight and wrap, Enter or Tab runs it, and
 * Escape closes the list until the trigger is typed again. The caret stays in the editor, which points at the list
 * with `aria-controls` and `aria-activedescendant`.
 */
export const UEditorSuggestionMenu = defineComponent({
  name: "UEditorSuggestionMenu",
  inheritAttrs: false,
  props: {
    editor: { required: true, type: Object as PropType<Editor> },
    items: { default: () => [], type: Array as PropType<EditorSuggestionMenuItem[] | EditorSuggestionMenuItem[][]> },
    char: { default: "/", type: String },
    filterFields: { default: () => ["label"], type: Array as PropType<string[]> },
    limit: { default: 42, type: Number },
    ui: { default: () => ({}), type: Object as PropType<{ content?: string }> },
  },
  setup(props, { attrs }) {
    const UIcon = useUIComponent("UIcon");
    const handlers = useHandlers();
    const query = ref("");
    const adapter = shallowRef<TextEditorAdapter>();
    onMounted(() => {
      if (!props.editor.isDestroyed) adapter.value = tiptapAdapter(props.editor);
    });

    const flat = computed(() => groupsOf(props.items).flat());
    const matches = computed(() => rank(flat.value, query.value, props.filterFields).slice(0, props.limit));
    // Groups keep the order of `items`, and inside each group the best match comes first.
    const groups = computed(() => groupsOf(props.items)
      .map(group => group.filter(item => matches.value.includes(item)).sort((a, b) => matches.value.indexOf(a) - matches.value.indexOf(b)))
      .filter(group => group.some(choosable)));
    // ui-sdk filters nothing: the items rendered are the matches.
    const triggers = computed(() => [{ char: props.char, filter: false as const }]);

    const onSelect = (value: string, details: { match: { end: number, start: number }, preventDefault: () => void }) => {
      details.preventDefault();
      const item = flat.value[Number(value)];
      if (!item?.kind) return;
      props.editor.chain().focus().deleteRange({ from: details.match.start, to: details.match.end }).run();
      handlers.value[item.kind]?.execute(props.editor, item).run();
    };

    return () => h(SlashMenu, {
      editor: adapter.value,
      loop: true,
      triggers: triggers.value,
      onQueryChange: (next: string) => (query.value = next),
      onSelect,
    }, () => [
      h(SlashStatus, { class: "vh-editor-suggestion-menu__status" }),
      h(SlashContent, {
        ...attrs,
        align: "start",
        class: ["vh-editor-suggestion-menu", props.ui.content, attrs.class],
        collisionPadding: 8,
        side: "bottom",
        sideOffset: 8,
      }, () => h(SlashList, { "aria-label": "Insert block" }, () => groups.value.flatMap((group, groupIndex) => [
        groupIndex ? h(TriggerMenuSeparator, { key: `separator-${groupIndex}` }) : null,
        h(TriggerMenuGroup, { key: `group-${groupIndex}` }, () => group.map((item, index) => {
          if (item.type === "label") return h(TriggerMenuGroupLabel, { class: item.class, key: `label-${index}` }, () => item.label);
          if (item.type === "separator") return h(TriggerMenuSeparator, { key: `separator-${index}` });
          const value = String(flat.value.indexOf(item));
          return h(SlashItem, { class: item.class, disabled: item.disabled, key: value, keywords: item.keywords, label: item.label, value }, () => [
            item.icon ? h(TriggerMenuItemIcon, () => h(UIcon, { name: item.icon })) : null,
            h("span", { "data-slot": "editor-suggestion-text" }, [
              h("span", { "data-slot": "editor-suggestion-label" }, item.label),
              item.description ? h("span", { "data-slot": "editor-suggestion-description" }, item.description) : null,
            ]),
          ]);
        })),
      ]))),
    ]);
  },
});

/** The block that the handle points at: its JSON and its position in the document. */
export interface EditorDragHandleNode { node: JSONContent, pos: number }

/**
 * Nuxt UI's `UEditorDragHandle`: a handle beside the block under the pointer, which drags the block to move it. A press
 * selects the block and emits `nodeChange`. The default slot replaces the button and gets `onClick`, which selects the
 * block and returns it, and `ui.handle()`, the class of a handle button.
 */
export const UEditorDragHandle = defineComponent({
  name: "UEditorDragHandle",
  inheritAttrs: false,
  props: {
    editor: { required: true, type: Object as PropType<Editor> },
    icon: { default: undefined, type: String },
    nested: { default: false, type: [Boolean, Object] as PropType<boolean | Record<string, unknown>> },
    pluginKey: { default: undefined, type: [String, Object] as PropType<string | PluginKey> },
    ui: { default: () => ({}), type: Object as PropType<{ root?: string, handle?: string }> },
  },
  emits: { hover: (_node: EditorDragHandleNode) => true, nodeChange: (_node: EditorDragHandleNode) => true },
  setup(props, { attrs, emit, slots }) {
    const UButton = useUIComponent("UButton");
    const current = ref<number>();

    const nodeAt = (pos: number | undefined): EditorDragHandleNode | undefined => {
      if (pos == null || pos < 0) return undefined;
      const node = props.editor.state.doc.nodeAt(pos);
      return node ? { node: node.toJSON(), pos } : undefined;
    };
    const onNodeChange = ({ pos }: { pos: number }) => {
      current.value = pos;
      const found = nodeAt(pos);
      if (found) emit("hover", found);
    };
    const onClick = (): EditorDragHandleNode | undefined => {
      const found = nodeAt(current.value);
      if (!found) return undefined;
      emit("nodeChange", found);
      props.editor.chain().setNodeSelection(found.pos).run();
      return found;
    };
    const ui = { handle: (options?: { class?: unknown }) => ["vh-editor-drag-handle__handle", props.ui.handle, options?.class].filter(Boolean).join(" ") };

    // Nuxt UI's place: left of the block and 8px from it, centered beside a short block and at the top of a tall one. It
    // flips to the other side and shifts to stay in the viewport, as Nuxt UI's does.
    const computePositionConfig = {
      middleware: [
        offset(({ rects }) => ({
          alignmentAxis: rects.reference.height > 40 ? 0 : (rects.reference.height - rects.floating.height) / 2,
          mainAxis: 8,
        })),
        flip(),
        shift(),
      ],
      placement: "left-start" as const,
      strategy: "absolute" as const,
    };

    return () => h(BlockHandle, {
      class: ["vh-editor-drag-handle", props.ui.root].filter(Boolean).join(" "),
      computePositionConfig,
      "data-slot": "editor-drag-handle",
      editor: props.editor,
      nested: props.nested,
      onClick,
      onNodeChange,
      ...(props.pluginKey ? { pluginKey: props.pluginKey } : {}),
    }, () => slots.default
      ? slots.default({ onClick, ui })
      : h(UButton, {
          "aria-label": "Drag to move, or press to select the block",
          color: "neutral",
          icon: props.icon ?? "i-lucide-grip-vertical",
          size: "sm",
          variant: "ghost",
          ...attrs,
          class: ui.handle({ class: attrs.class }),
          "data-slot": "editor-drag-handle-button",
        }));
  },
});
