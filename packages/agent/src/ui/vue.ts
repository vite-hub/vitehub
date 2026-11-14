import { type ComponentRegistry, type ComponentRenderProps, useStateStore } from "@json-render/vue"
import { Button as SdkButton } from "@ui-sdk/vue/button"
import { Separator } from "@ui-sdk/vue/separator"
import { Tabs as SdkTabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/vue/tabs"
import { formFields } from "@vite-hub/forms"
import { type Component, defineComponent, type FunctionalComponent, h, type PropType, toHandlerKey, useId, type VNodeChild } from "vue"

import type { FormField } from "@vite-hub/forms"
import type { Catalog, CatalogEntry } from "./define.ts"
import type { ViteHubComponent } from "./entries.ts"

/** The Vue component for each entry of a catalog, by entry name. */
export type CatalogComponents<Name extends string = string> = Readonly<Record<Name, Component>>

/**
 * Wraps the app's component for one entry. The component gets the element's props as Vue props, a listener for each
 * event of the entry (`onPress` for `press`), and an `onUpdate:<prop>` listener for each prop bound with `$bindState`,
 * so `v-model:<prop>` works. A Form also gets `fields`, the fields of its form from `formFields()` of `@vite-hub/forms`.
 * The element's children are its default slot.
 */
function catalogPart(catalog: Catalog, entry: CatalogEntry, component: Component): Component {
  return defineComponent({
    name: `Catalog${entry.name}`,
    inheritAttrs: false,
    props: {
      // SAFETY: json-render passes the element after it resolves the expressions of its props.
      element: { type: Object as PropType<ComponentRenderProps["element"]>, required: true },
      emit: { type: Function as PropType<(event: string) => void>, required: true },
      bindings: { type: Object as PropType<Record<string, string>>, default: undefined },
    },
    setup(props, { slots }) {
      const store = useStateStore()
      return () => {
        const listeners: Record<string, (value: unknown) => void> = {}
        for (const event of Object.keys(entry.events)) listeners[toHandlerKey(event)] = () => props.emit(event)
        for (const [prop, path] of Object.entries(props.bindings ?? {})) listeners[`onUpdate:${prop}`] = value => store.set(path, value)
        const form = entry.name === "Form" ? props.element.props.form : undefined
        const fields = typeof form === "string" && Object.hasOwn(catalog.forms, form) ? { fields: formFields(catalog.forms[form]!) } : {}
        return h(component, { ...props.element.props, ...fields, ...listeners }, slots)
      }
    },
  })
}

/**
 * Builds the json-render registry of a catalog from one Vue component for each entry. Pass the registry to `Renderer`
 * and `JSONUIProvider` of `@json-render/vue`.
 *
 * @example
 * ```ts
 * const registry = defineCatalogRegistry(catalog, { ...catalogComponents, Button: MyButton })
 * ```
 */
export function defineCatalogRegistry<Name extends string>(catalog: Catalog<Name>, components: CatalogComponents<Name>): ComponentRegistry {
  const registry: ComponentRegistry = {}
  for (const entry of Object.values<CatalogEntry>(catalog.entries)) {
    const component: Component | undefined = Object.hasOwn(components, entry.name) ? components[entry.name as Name] : undefined
    if (component) registry[entry.name] = catalogPart(catalog, entry, component)
  }
  return registry
}

type Props = Record<string, unknown>
type Listener = (value?: unknown) => void

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""
}

function listener(props: Props, name: string): Listener | undefined {
  const value = props[name]
  return typeof value === "function" ? (next?: unknown) => { value(next) } : undefined
}

function list(value: unknown): Props[] {
  return Array.isArray(value) ? value.filter((item): item is Props => typeof item === "object" && item !== null) : []
}

// SAFETY: the registry passes `fields` from `formFields()` of @vite-hub/forms (see `catalogPart`).
const formFieldList = (value: unknown): FormField[] => Array.isArray(value) ? value.filter((item): item is FormField => typeof item === "object" && item !== null && "name" in item && "type" in item) : []

const record = (value: unknown): Props => typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {}

/** A component that renders from its props and default slot. */
function part(name: string, render: (props: Props, children: VNodeChild[]) => VNodeChild): FunctionalComponent<Props> {
  const component: FunctionalComponent<Props> = (props, { slots }) => render(props, slots.default?.() ?? [])
  component.displayName = name
  return component
}

/** What a form control reports: its text, and for a checkbox, whether it is checked. */
interface ControlState {
  value: string
  checked?: boolean
}

/** The text and checked state of the control that sent `event`. Read without DOM types, so the file builds for the server too. */
function controlState(event: Event): ControlState | undefined {
  const target: unknown = event.target
  if (typeof target !== "object" || target === null || !("value" in target)) return undefined
  return { value: String(target.value), ...("checked" in target && typeof target.checked === "boolean" ? { checked: target.checked } : {}) }
}

/** The value of a control as the type of its field, as a person enters it. `undefined` leaves the field out. */
function fieldValue(field: FormField, control: ControlState): unknown {
  if (field.type === "boolean") return control.checked ?? control.value === "true"
  if (field.options) return field.options.find(option => String(option) === control.value)
  if (field.type === "number" || field.type === "integer") return control.value === "" ? undefined : Number(control.value)
  return control.value
}

const inputTypes: Record<string, string> = { "email": "email", "uri": "url", "date": "date", "date-time": "datetime-local" }

/** One native control for a form field. It reads and writes the Form's bound values. */
const FormControl = defineComponent({
  name: "CatalogFormControl",
  props: {
    field: { type: Object as PropType<FormField>, required: true },
    /** The Form's bound values, by field name. */
    values: { type: Object as PropType<Props>, required: true },
  },
  emits: { change: (_value: unknown) => true },
  setup(props, { emit }) {
    const id = useId()
    return () => {
      const { field } = props
      const value = props.values[field.name]
      const onChange = (event: Event) => {
        const control = controlState(event)
        if (control) emit("change", fieldValue(field, control))
      }
      const common = { id, name: field.name, required: field.required, onChange, ...(field.description ? { "aria-description": field.description } : {}) }
      const label = h("label", { for: id }, field.label)
      if (field.type === "boolean") {
        return h("div", { "data-slot": "form-field" }, [h("input", { ...common, type: "checkbox", checked: value === true, required: false }), label])
      }
      if (field.options) {
        return h("div", { "data-slot": "form-field" }, [label, h("select", common, [
          h("option", { value: "", disabled: field.required, selected: value === undefined }, ""),
          ...field.options.map(option => h("option", { value: String(option), selected: option === value }, String(option))),
        ])])
      }
      const type = field.type === "string" ? inputTypes[field.format ?? ""] ?? "text" : "number"
      return h("div", { "data-slot": "form-field" }, [label, h("input", {
        ...common,
        type,
        value: text(value),
        ...(field.minLength !== undefined ? { minlength: field.minLength } : {}),
        ...(field.maxLength !== undefined ? { maxlength: field.maxLength } : {}),
        ...(field.minimum !== undefined ? { min: field.minimum } : {}),
        ...(field.maximum !== undefined ? { max: field.maximum } : {}),
      })])
    }
  },
})

/**
 * Plain components for every built-in entry. Button, Divider, and Tabs use `@ui-sdk/vue`, and a Form draws one native
 * control for each field of its form. They have behavior, focus, and ARIA but no styles, so a spec renders before an app
 * adds its own components.
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
  Button: part("Button", props => h(SdkButton, { "type": "button", "data-variant": props.variant ?? "secondary", "onClick": () => listener(props, "onPress")?.() }, () => text(props.label))),
  Link: part("Link", props => h("a", { "data-slot": "link", "href": text(props.href), "target": "_blank", "rel": "noopener noreferrer" }, text(props.text))),
  Image: part("Image", props => h("img", { "data-slot": "image", "src": text(props.src), "alt": text(props.alt) })),
  Badge: part("Badge", props => h("span", { "data-slot": "badge", "data-tone": props.tone ?? "neutral" }, text(props.text))),
  Table: part("Table", (props) => {
    const columns = list(props.columns)
    return h("table", { "data-slot": "table" }, [
      props.caption ? h("caption", text(props.caption)) : null,
      h("thead", h("tr", columns.map(column => h("th", { scope: "col" }, text(column.label))))),
      h("tbody", list(props.rows).map(row => h("tr", columns.map(column => h("td", text(row[text(column.key)])))))),
    ])
  }),
  Tabs: part("Tabs", (props, children) => {
    const titles = Array.isArray(props.tabs) ? props.tabs.map(text) : []
    // Panels that are not shown stay in the page, hidden until found, so find in page and a server render reach them.
    return h(SdkTabs, { defaultValue: "0", hiddenUntilFound: true }, () => [
      h(TabsList, null, () => titles.map((title, index) => h(TabsTab, { value: String(index) }, () => title))),
      ...children.map((child, index) => h(TabsPanel, { value: String(index) }, () => child)),
    ])
  }),
  Form: part("Form", (props) => {
    const values = record(props.value)
    const update = listener(props, "onUpdate:value")
    return h("form", {
      "data-slot": "form",
      "data-form": text(props.form),
      "onSubmit": (event: Event) => {
        event.preventDefault()
        listener(props, "onSubmit")?.()
      },
    }, [
      ...formFieldList(props.fields).map(field => h(FormControl, {
        key: field.name,
        field,
        values,
        onChange: (value: unknown) => {
          const next = record(props.value)
          if (value === undefined) delete next[field.name]
          else next[field.name] = value
          update?.(next)
        },
      })),
      h(SdkButton, { "type": "submit", "data-variant": "primary" }, () => text(props.submitLabel) || "Send"),
    ])
  }),
}
