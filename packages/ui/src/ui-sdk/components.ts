import { Button as ButtonPart } from "@ui-sdk/vue/button";
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/vue/dialog";
import { Input, InputGroup } from "@ui-sdk/vue/input";
import { Menu, MenuCheckboxItem, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuItemIcon, MenuItemIndicator, MenuSeparator, MenuTrigger } from "@ui-sdk/vue/menu";
import { Tabs, TabsList, TabsTab } from "@ui-sdk/vue/tabs";
import { cloneVNode, type Component, computed, defineAsyncComponent, defineComponent, h, isVNode, nextTick, onMounted, ref, type PropType, type VNode } from "vue";

import { useViteHubUIIcons } from "../config.ts";
import { lucideStroke } from "../internal/icon-shapes.ts";
import { useUIComponent, type ViteHubUIComponents } from "../internal/nuxt-ui.ts";
import { uiSdkIcons } from "./icons.ts";

/**
 * The parts render Nuxt UI components by name (see `internal/nuxt-ui.ts`). These take the same props that the parts
 * pass, render ui-sdk parts, and carry the `data-slot` and `data-variant` names that the kit style family
 * (`@vite-hub/kit/styles/default.css`) styles.
 */

/** Draws the Lucide icons that the parts use, from shapes in the bundle. Another name draws an empty icon. */
const UIcon = defineComponent({
  name: "UIcon",
  inheritAttrs: false,
  props: { name: { default: "", type: String } },
  setup(props, { attrs }) {
    // Elements, not markup: nothing here parses a string, so a Trusted Types policy has nothing to refuse.
    return () => h("svg", { ...lucideStroke, "aria-hidden": "true", ...attrs, height: "1em", viewBox: "0 0 24 24", width: "1em" }, uiSdkIcons[props.name]?.map(([tag, shape]) => h(tag, shape)));
  },
});

// Attributes reach a component untyped. The ones that these read are strings.
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

// The button takes the part's attributes as they come, so it is typed as any component.
const Button: Component = ButtonPart;

type ButtonColor = "primary" | "secondary" | "success" | "info" | "warning" | "error" | "neutral";
type ButtonVariant = "solid" | "outline" | "soft" | "subtle" | "ghost" | "link";

// The kit draws a plain button as Nuxt UI's outline one, and has `solid`, `destructive`, `soft`, `ghost` and `link`.
function buttonVariant(color: ButtonColor, variant: ButtonVariant): string | undefined {
  if (variant === "ghost" || variant === "link") return variant;
  if (color === "error") return "destructive";
  if (variant === "soft" || variant === "subtle") return "soft";
  return variant === "solid" ? "solid" : undefined;
}

/**
 * Nuxt UI's `UButton` as the parts use it. A part that names its button, such as `data-slot="copy-button"`, finds the
 * name in `data-part`, because `data-slot="button"` is what the kit styles.
 */
const UButton = defineComponent({
  name: "UButton",
  inheritAttrs: false,
  props: {
    color: { default: "primary", type: String as PropType<ButtonColor> },
    disabled: { default: false, type: Boolean },
    /** Nuxt UI opens `to` in the same tab unless `target` says otherwise. A plain link does the same. */
    external: { default: undefined, type: Boolean },
    icon: { type: String },
    label: { type: String },
    loading: { default: false, type: Boolean },
    size: { default: "md", type: String },
    square: { default: false, type: Boolean },
    to: { type: String },
    trailingIcon: { type: String },
    type: { default: "button", type: String as PropType<"button" | "reset" | "submit"> },
    ui: { type: Object },
    variant: { default: "solid", type: String as PropType<ButtonVariant> },
  },
  setup(props, { attrs, slots }) {
    const UIcon = useUIComponent("UIcon");
    return () => {
      const shared = {
        ...attrs,
        "aria-busy": props.loading ? "true" : text(attrs["aria-busy"]),
        "data-part": text(attrs["data-slot"]),
        "data-size": props.size,
        "data-slot": "button",
        "data-variant": buttonVariant(props.color, props.variant),
      };
      const leading = props.loading ? "i-lucide-loader-circle" : props.icon;
      const content = () => [
        slots.leading ? slots.leading({}) : leading ? h(UIcon, { "data-slot": props.loading ? "spinner" : undefined, name: leading }) : null,
        slots.default ? slots.default() : props.label ? h("span", props.label) : null,
        props.trailingIcon ? h(UIcon, { name: props.trailingIcon }) : null,
      ];
      if (props.to) return h("a", { ...shared, href: props.to }, content());
      return h(Button, { ...shared, disabled: props.disabled || props.loading, type: props.type }, content);
    };
  },
});

/**
 * Nuxt UI's `UInput`: a frame with the `leading` and `trailing` slots around the input. `class` goes to the frame, and
 * a part's `data-slot` goes to `data-part` of the input, as on `UButton`.
 */
const UInput = defineComponent({
  name: "UInput",
  inheritAttrs: false,
  props: {
    autofocus: { default: false, type: Boolean },
    disabled: { default: false, type: Boolean },
    modelValue: { type: [String, Number] },
    size: { default: "md", type: String },
    type: { default: "text", type: String },
    ui: { type: Object },
  },
  emits: { "update:modelValue": (_value: string) => true },
  setup(props, { attrs, emit, slots }) {
    const input = ref<{ $el?: Element } | null>(null);
    // A native `autofocus` works only on the first page load, so focus the field once it mounts, as Nuxt UI does.
    onMounted(() => {
      if (props.autofocus) void nextTick(() => (input.value?.$el as HTMLElement | undefined)?.focus());
    });
    return () => {
      const { class: frameClass, "data-slot": part, style, ...field } = attrs;
      return h(InputGroup, { class: frameClass, "data-size": props.size, style }, () => [
        slots.leading?.(),
        h(Input, {
          ...field,
          "data-part": text(part),
          disabled: props.disabled,
          ref: input,
          type: props.type,
          value: props.modelValue === undefined ? "" : String(props.modelValue),
          "onUpdate:value": (value: string) => emit("update:modelValue", value),
        }),
        slots.trailing?.(),
      ]);
    };
  },
});

// A part's own trigger, such as a button, takes the trigger's props. ui-sdk reads a trigger's state attributes and
// ARIA, not its `data-slot`, so the element keeps its own slot and the look that comes with it.
function asTrigger(children: VNode[] | undefined, props: Record<string, unknown>): VNode | null {
  const vnode = children?.find(isVNode);
  if (!vnode) return null;
  const { "data-slot": _slot, ...trigger } = props;
  return cloneVNode(vnode, trigger, true);
}

/**
 * Nuxt UI's `UModal`: the default slot opens it, and `content` replaces the title, the description, `body`, and
 * `footer`. `open` with `update:open` controls it. `ui.overlay` and `ui.content` style the backdrop and the dialog.
 */
const UModal = defineComponent({
  name: "UModal",
  inheritAttrs: false,
  props: {
    close: { default: true, type: Boolean },
    description: { type: String },
    dismissible: { default: true, type: Boolean },
    open: { default: undefined, type: Boolean },
    title: { type: String },
    transition: { default: true, type: Boolean },
    ui: { default: () => ({}), type: Object as PropType<{ content?: string, overlay?: string }> },
  },
  emits: { "update:open": (_open: boolean) => true },
  setup(props, { emit, slots }) {
    const UIcon = useUIComponent("UIcon");
    const icons = useViteHubUIIcons();
    const inner = ref(false);
    const open = computed(() => props.open ?? inner.value);
    const setOpen = (value: boolean) => {
      inner.value = value;
      emit("update:open", value);
    };
    const close = () => setOpen(false);
    return () => h(Dialog, { dismissible: props.dismissible, open: open.value, onOpenChange: setOpen }, () => [
      slots.default ? h(DialogTrigger, null, { render: ({ props: trigger }: { props: Record<string, unknown> }) => asTrigger(slots.default?.(), trigger) }) : null,
      h(DialogBackdrop, { class: props.ui.overlay }),
      h(DialogContent, { "aria-label": slots.content ? props.title : undefined, class: props.ui.content }, () => slots.content
        ? slots.content({ close })
        : [
            props.title ? h(DialogTitle, () => props.title) : null,
            props.description ? h(DialogDescription, () => props.description) : null,
            slots.body?.({ close }),
            slots.footer ? h("div", { "data-slot": "dialog-footer" }, slots.footer({ close })) : null,
            props.close ? h(DialogClose, { "aria-label": "Close" }, () => h(UIcon, { name: icons.value.close })) : null,
          ]),
    ]);
  },
});

interface TabsItem { badge?: string | number | boolean, disabled?: boolean, icon?: string, label?: string, value: string | number }

/** Nuxt UI's `UTabs` with `content: false`, as the parts use it: a tab list from `items`, with `v-model`. */
const UTabs = defineComponent({
  name: "UTabs",
  inheritAttrs: false,
  props: {
    content: { default: true, type: Boolean },
    items: { default: () => [], type: Array as PropType<TabsItem[]> },
    modelValue: { type: [String, Number] },
  },
  emits: { "update:modelValue": (_value: string | number) => true },
  setup(props, { attrs, emit }) {
    const UIcon = useUIComponent("UIcon");
    return () => {
      const { "aria-label": label, ...root } = attrs;
      return h(Tabs, {
        ...root,
        value: props.modelValue === undefined ? undefined : String(props.modelValue),
        "onUpdate:value": (value: string | null) => {
          const item = props.items.find(entry => String(entry.value) === value);
          if (item) emit("update:modelValue", item.value);
        },
      }, () => h(TabsList, { "aria-label": text(label) }, () => props.items.map(item => h(TabsTab, { disabled: item.disabled, key: item.value, value: String(item.value) }, () => [
        item.icon ? h(UIcon, { name: item.icon }) : null,
        item.label,
        item.badge === undefined || item.badge === false ? null : h("span", { "data-slot": "tabs-tab-badge" }, item.badge === true ? "" : String(item.badge)),
      ]))));
    };
  },
});

interface MenuEntry { checked?: boolean, description?: string, disabled?: boolean, icon?: string, label?: string, onSelect?: (event: Event) => void, type?: "label" | "separator" | "link" | "checkbox" }

/**
 * Nuxt UI's `UDropdownMenu`: the default slot opens it, and `items` holds groups of entries, or one group.
 * `update:open` tells when it opens and closes.
 */
const UDropdownMenu = defineComponent({
  name: "UDropdownMenu",
  inheritAttrs: false,
  props: {
    content: { default: () => ({}), type: Object as PropType<{ align?: "start" | "center" | "end", side?: "top" | "right" | "bottom" | "left", sideOffset?: number }> },
    items: { default: () => [], type: Array as PropType<MenuEntry[] | MenuEntry[][]> },
    ui: { default: () => ({}), type: Object as PropType<{ content?: string }> },
  },
  emits: { "update:open": (_open: boolean) => true },
  setup(props, { emit, slots }) {
    const UIcon = useUIComponent("UIcon");
    const entry = (item: MenuEntry, index: number, group: number) => {
      if (item.type === "label") return h(MenuGroupLabel, { key: index }, () => item.label);
      if (item.type === "separator") return h(MenuSeparator, { key: index });
      const body = () => [
        item.icon ? h(MenuItemIcon, () => h(UIcon, { name: item.icon })) : null,
        h("span", item.label),
        item.description ? h("span", { "data-slot": "menu-item-description" }, item.description) : null,
      ];
      if (item.type === "checkbox") {
        return h(MenuCheckboxItem, {
          checked: item.checked ?? false,
          closeOnSelect: true,
          disabled: item.disabled,
          key: index,
          label: item.label,
          value: `${group}-${index}`,
          onCheckedChange: (_checked: boolean, details: { event?: Event }) => item.onSelect?.(details.event ?? new Event("select")),
        }, () => [h(MenuItemIndicator), ...body()]);
      }
      return h(MenuItem, { disabled: item.disabled, key: index, label: item.label, onSelect: item.onSelect }, body);
    };
    return () => {
      const groups = (props.items.length && Array.isArray(props.items[0]) ? props.items : [props.items]) as MenuEntry[][];
      return h(Menu, { onOpenChange: (open: boolean) => emit("update:open", open) }, () => [
        h(MenuTrigger, null, { render: ({ props: trigger }: { props: Record<string, unknown> }) => asTrigger(slots.default?.(), trigger) }),
        h(MenuContent, { ...props.content, class: props.ui.content }, () => groups.flatMap((group, index) => [
          index ? h(MenuSeparator, { key: `separator-${index}` }) : null,
          h(MenuGroup, { key: `group-${index}` }, () => group.map((item, position) => entry(item, position, index))),
        ])),
      ]);
    };
  },
});

// The editor parts load Tiptap's menu plugins, so they load on first render, as Nuxt UI's do: a page without an editor
// never loads them.
const UEditorDragHandle = defineAsyncComponent(() => import("./editor.ts").then(parts => parts.UEditorDragHandle));
const UEditorSuggestionMenu = defineAsyncComponent(() => import("./editor.ts").then(parts => parts.UEditorSuggestionMenu));
const UEditorToolbar = defineAsyncComponent(() => import("./editor.ts").then(parts => parts.UEditorToolbar));

/**
 * The components that the parts render, on ui-sdk instead of Nuxt UI. Give them to `createViteHubUI({ components })`
 * and load the kit style family. `UIcon` draws the icons that the parts use; to show other icons, such as your own in
 * `createViteHubUI({ icons })`, pass your own `UIcon` next to these.
 */
export const uiSdkComponents: ViteHubUIComponents = { UButton, UDropdownMenu, UEditorDragHandle, UEditorSuggestionMenu, UEditorToolbar, UIcon, UInput, UModal, UTabs };
