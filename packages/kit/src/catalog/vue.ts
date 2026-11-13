import { type ComponentRegistry, type ComponentRenderProps, useStateStore } from "@json-render/vue";
import { Button as KitButton } from "@ui-sdk/vue/button";
import { Checkbox as KitCheckbox } from "@ui-sdk/vue/checkbox";
import { Dialog as KitDialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/vue/dialog";
import { Field as KitField, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@ui-sdk/vue/field";
import { Input as KitInput } from "@ui-sdk/vue/input";
import { Radio, RadioGroup as KitRadioGroup } from "@ui-sdk/vue/radio";
import { Separator } from "@ui-sdk/vue/separator";
import { Switch as KitSwitch } from "@ui-sdk/vue/switch";
import { Tabs as KitTabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/vue/tabs";
import { Textarea as KitTextarea } from "@ui-sdk/vue/textarea";
import { type Component, defineComponent, type FunctionalComponent, h, type PropType, toHandlerKey, type VNodeChild } from "vue";

import type { Catalog, CatalogEntry } from "./define.ts";
import type { ViteHubComponent } from "./entries.ts";

/** The Vue component for each entry of a catalog, by entry name. */
export type CatalogComponents<Name extends string = string> = Readonly<Record<Name, Component>>;

/**
 * Wraps the app's component for one entry. The component gets the element's props as Vue props, a listener for each
 * event of the entry (`onPress` for `press`), and an `onUpdate:<prop>` listener for each prop bound with `$bindState`,
 * so `v-model:<prop>` works. The element's children are its default slot.
 */
function catalogPart(entry: CatalogEntry, component: Component): Component {
  return defineComponent({
    name: `Catalog${entry.name}`,
    inheritAttrs: false,
    props: {
      // SAFETY: json-render passes the element after it resolves `$state` reads and `$bindState` bindings.
      element: { type: Object as PropType<ComponentRenderProps["element"]>, required: true },
      emit: { type: Function as PropType<(event: string) => void>, required: true },
      bindings: { type: Object as PropType<Record<string, string>>, default: undefined },
    },
    setup(props, { slots }) {
      const store = useStateStore();
      return () => {
        const listeners: Record<string, (value: unknown) => void> = {};
        for (const event of Object.keys(entry.events)) listeners[toHandlerKey(event)] = () => props.emit(event);
        for (const [prop, path] of Object.entries(props.bindings ?? {})) listeners[`onUpdate:${prop}`] = value => store.set(path, value);
        return h(component, { ...props.element.props, ...listeners }, slots);
      };
    },
  });
}

/**
 * Builds the json-render registry of a catalog from one Vue component for each entry. Pass the registry to `Renderer`
 * and `JSONUIProvider` of `@json-render/vue`.
 *
 * @example
 * ```ts
 * const registry = defineCatalogRegistry(viteHubCatalog, { ...catalogComponents, Button: MyButton });
 * ```
 */
export function defineCatalogRegistry<Name extends string>(catalog: Catalog<Name>, components: CatalogComponents<Name>): ComponentRegistry {
  const registry: ComponentRegistry = {};
  for (const entry of Object.values<CatalogEntry>(catalog.entries)) {
    const component: Component | undefined = Object.hasOwn(components, entry.name) ? components[entry.name as Name] : undefined;
    if (component) registry[entry.name] = catalogPart(entry, component);
  }
  return registry;
}

type Props = Record<string, unknown>;
type Listener = (value?: unknown) => void;

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function listener(props: Props, name: string): Listener | undefined {
  const value = props[name];
  return typeof value === "function" ? (next?: unknown) => { value(next); } : undefined;
}

function list(value: unknown): Props[] {
  return Array.isArray(value) ? value.filter((item): item is Props => typeof item === "object" && item !== null) : [];
}

/** A component that renders from its props and default slot. */
function part(name: string, render: (props: Props, children: VNodeChild[]) => VNodeChild): FunctionalComponent<Props> {
  const component: FunctionalComponent<Props> = (props, { slots }) => render(props, slots.default?.() ?? []);
  component.displayName = name;
  return component;
}

function labelled(props: Props, control: VNodeChild): VNodeChild {
  return h(KitField, null, () => [h(FieldLabel, null, () => text(props.label)), control]);
}

/**
 * Plain components for every built-in entry, built from the headless parts of `@vite-hub/kit` and plain elements. They
 * have behavior, focus, and ARIA but no styles, so a spec renders before an app adds its own components.
 */
export const catalogComponents: CatalogComponents<ViteHubComponent> = {
  Stack: part("Stack", (props, children) => h("div", {
    "data-slot": "stack",
    "style": {
      display: "flex",
      flexDirection: props.direction === "horizontal" ? "row" : "column",
      alignItems: text(props.align) || "stretch",
      justifyContent: props.justify === "spaceBetween" ? "space-between" : text(props.justify) || "start",
      gap: "0.5rem",
    },
  }, children)),
  Text: part("Text", props => h("p", { "data-slot": "text", "data-tone": props.tone }, text(props.text))),
  Heading: part("Heading", props => h(`h${typeof props.level === "number" ? props.level : 2}`, { "data-slot": "heading" }, text(props.text))),
  KeyValue: part("KeyValue", props => h("dl", { "data-slot": "key-value" }, [h("dt", text(props.label)), h("dd", text(props.value))])),
  Divider: part("Divider", () => h(Separator)),
  Card: part("Card", (props, children) => h("section", { "data-slot": "card" }, [
    props.title ? h("h3", text(props.title)) : null,
    props.description ? h("p", text(props.description)) : null,
    ...children,
  ])),
  Button: part("Button", props => h(KitButton, { "type": "button", "data-variant": props.variant ?? "secondary", "onClick": () => listener(props, "onPress")?.() }, () => text(props.label))),
  Link: part("Link", props => h("a", { "data-slot": "link", "href": text(props.href), "target": "_blank", "rel": "noopener noreferrer" }, text(props.text))),
  Image: part("Image", props => h("img", { "data-slot": "image", "src": text(props.src), "alt": text(props.alt) })),
  Badge: part("Badge", props => h("span", { "data-slot": "badge", "data-tone": props.tone ?? "neutral" }, text(props.text))),
  Table: part("Table", (props) => {
    const columns = list(props.columns);
    return h("table", { "data-slot": "table" }, [
      props.caption ? h("caption", text(props.caption)) : null,
      h("thead", h("tr", columns.map(column => h("th", { scope: "col" }, text(column.label))))),
      h("tbody", list(props.rows).map(row => h("tr", columns.map(column => h("td", text(row[text(column.key)])))))),
    ]);
  }),
  Form: part("Form", (props, children) => h("form", {
    "data-slot": "form",
    "onSubmit": (event: Event) => {
      event.preventDefault();
      listener(props, "onSubmit")?.();
    },
  }, [...children, h(KitButton, { "type": "submit", "data-variant": "primary" }, () => text(props.submitLabel))])),
  Field: part("Field", (props, children) => h(FieldSet, null, () => [
    h(FieldLegend, null, () => text(props.label)),
    props.description ? h(FieldDescription, null, () => text(props.description)) : null,
    ...children,
  ])),
  Input: part("Input", props => labelled(props, h(KitInput, {
    "type": text(props.type) || "text",
    "placeholder": text(props.placeholder) || undefined,
    "value": text(props.value),
    "onUpdate:value": listener(props, "onUpdate:value"),
  }))),
  Textarea: part("Textarea", props => labelled(props, h(KitTextarea, {
    "placeholder": text(props.placeholder) || undefined,
    "value": text(props.value),
    "onUpdate:value": listener(props, "onUpdate:value"),
  }))),
  Select: part("Select", props => h("label", { "data-slot": "select" }, [
    text(props.label),
    h("select", {
      "value": text(props.value),
      "onChange": (event: Event) => listener(props, "onUpdate:value")?.(event.target instanceof HTMLSelectElement ? event.target.value : undefined),
    }, [
      props.placeholder ? h("option", { value: "", disabled: true }, text(props.placeholder)) : null,
      ...list(props.options).map(option => h("option", { value: text(option.value), selected: option.value === props.value }, text(option.label))),
    ]),
  ])),
  RadioGroup: part("RadioGroup", props => h(KitRadioGroup, {
    "aria-label": text(props.label),
    "value": typeof props.value === "string" ? props.value : null,
    "onUpdate:value": listener(props, "onUpdate:value"),
  }, () => list(props.options).map(option => h("label", null, [h(Radio, { value: text(option.value) }), text(option.label)])))),
  Checkbox: part("Checkbox", props => h("label", { "data-slot": "checkbox-field" }, [
    h(KitCheckbox, { "checked": props.checked === true, "onUpdate:checked": listener(props, "onUpdate:checked") }),
    text(props.label),
  ])),
  Switch: part("Switch", props => h("label", { "data-slot": "switch-field" }, [
    h(KitSwitch, { "checked": props.checked === true, "onUpdate:checked": listener(props, "onUpdate:checked") }),
    text(props.label),
  ])),
  Tabs: part("Tabs", (props, children) => {
    const titles = Array.isArray(props.tabs) ? props.tabs.map(text) : [];
    return h(KitTabs, { defaultValue: "0" }, () => [
      h(TabsList, null, () => titles.map((title, index) => h(TabsTab, { value: String(index) }, () => title))),
      ...children.map((child, index) => h(TabsPanel, { value: String(index) }, () => child)),
    ]);
  }),
  Dialog: part("Dialog", (props, children) => h(KitDialog, null, () => [
    h(DialogTrigger, null, () => text(props.triggerLabel)),
    h(DialogContent, null, () => [
      h(DialogTitle, null, () => text(props.title)),
      props.description ? h(DialogDescription, null, () => text(props.description)) : null,
      ...children,
      h(DialogClose, null, () => "Close"),
    ]),
  ])),
};
