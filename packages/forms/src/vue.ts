import { getInput, handleSubmit, reset, setErrors, useField, useForm } from "@formisch/vue"
import { computed, defineComponent, h, ref } from "vue"

import { submitForm } from "./client.ts"

import type { FormSchema, FormStore } from "@formisch/vue"
import type { PropType, Ref, VNode } from "vue"
import type { FormAnchor, FormSubmitError, SubmitFormOptions } from "./client.ts"

export { FormSubmitError, formRoute, submitForm } from "./client.ts"
export type { FormAnchor, FormIssue, SubmitFormOptions } from "./client.ts"

/** What `useFormSubmit()` returns. */
export interface FormSubmitState {
  /**
   * Sends the input of the form, not the output of its schema, since the server validates the same schema again. Pass
   * fields that are not in the form, such as a honeypot, as `extra`: `<Form :of="form" @submit="() => send()">`.
   */
  send: (extra?: Record<string, unknown>) => Promise<void>
  /** The id of the stored submission after a success. */
  sent: Ref<string | true | undefined>
  /** The last failure. Field issues are also set on the Formisch form, under their field. */
  error: Ref<FormSubmitError | undefined>
}

/**
 * Sends a Formisch form to `server/forms/<name>.ts`. A 400 puts each server issue under its field with Formisch
 * `setErrors()`, and an issue of the whole form on the form. A success resets the form.
 */
export function useFormSubmit<TSchema extends FormSchema>(name: string, form: FormStore<TSchema>, options: SubmitFormOptions = {}): FormSubmitState {
  const sent = ref<string | true>()
  const error = ref<FormSubmitError>()
  async function send(extra: Record<string, unknown> = {}) {
    sent.value = undefined
    error.value = undefined
    const [failure, data] = await submitForm(name, { ...getInput(form), ...extra }, options)
    if (!failure) {
      sent.value = data.id ?? true
      reset(form)
      return
    }
    error.value = failure
    const formIssues = failure.issues.filter(issue => issue.path.length === 0).map(issue => issue.message)
    // SAFETY: the server validated the same schema, so its issue paths are paths of this form. Formisch types a path
    // from the schema, and these come from JSON.
    const setFieldErrors = setErrors as (form: FormStore<TSchema>, config: { path: (string | number)[], errors: [string] }) => void
    for (const issue of failure.issues) {
      if (issue.path.length) setFieldErrors(form, { path: issue.path, errors: [issue.message] })
    }
    const message = formIssues[0] ?? (failure.issues.length ? undefined : failure.message)
    if (message) setErrors(form, { errors: [message, ...formIssues.slice(1)] })
  }
  return { send, sent, error }
}

/** The parts of a Valibot schema that `AutoForm` reads. */
interface SchemaNode {
  type: string
  wrapped?: SchemaNode
  pipe?: readonly SchemaNode[]
  entries?: Record<string, SchemaNode>
  options?: readonly unknown[]
  enum?: Record<string, unknown>
  requirement?: unknown
  title?: string
  description?: string
}

/** One field that `AutoForm` draws. */
export interface AutoFormField {
  key: string
  label: string
  description?: string
  control: "input" | "textarea" | "select" | "checkbox"
  /** The `type` of an `input`: text, email, url, or number. */
  inputType?: "text" | "email" | "url" | "number"
  /** The values of a select, with their type: a picklist of numbers gives numbers. */
  options?: readonly (string | number)[]
  required: boolean
  maxLength?: number
}

const longTextKeys = /^(message|details|description|text|body|comment|feedback|workflow|notes?)$/i

function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function unwrap(node: SchemaNode): { node: SchemaNode, required: boolean } {
  let current = node
  let required = true
  while (["optional", "nullish", "nullable", "exact_optional", "undefinedable"].includes(current.type) && current.wrapped) {
    required = false
    current = current.wrapped
  }
  return { node: current, required }
}

/**
 * The fields of a Valibot object schema, in order: a string becomes a text, email, or url input, or a textarea when it
 * is long; a number becomes a number input; a boolean a checkbox; a picklist or enum a select. `v.title()` and
 * `v.description()` set the label and the help text.
 */
export function describeFormFields(schema: unknown): AutoFormField[] {
  const root = schema as SchemaNode
  if (root?.type !== "object" || !root.entries) throw new TypeError("[vitehub] AutoForm needs a Valibot object schema, such as v.object({ message: v.string() }).")
  return Object.entries(root.entries).map(([key, entry]) => {
    const { node, required } = unwrap(entry)
    const actions = node.pipe ?? []
    const action = (type: string) => actions.find(item => item.type === type)
    const label = action("title")?.title ?? humanize(key)
    const description = action("description")?.description
    const max = action("max_length")?.requirement
    const field: AutoFormField = { key, label, control: "input", required, ...(description ? { description } : {}), ...(typeof max === "number" ? { maxLength: max } : {}) }
    const base = node.type
    if (base === "boolean") return { ...field, control: "checkbox", required: false }
    if (base === "number") return { ...field, inputType: "number" }
    // `options` of a Valibot enum holds its values without the reverse keys of a TypeScript numeric enum.
    if (base === "picklist" || base === "enum") return { ...field, control: "select", options: (node.options ?? []).filter((option): option is string | number => typeof option === "string" || typeof option === "number") }
    if (action("email")) return { ...field, inputType: "email" }
    if (action("url")) return { ...field, inputType: "url" }
    if (longTextKeys.test(key) || (typeof max === "number" && max > 200)) return { ...field, control: "textarea" }
    return { ...field, inputType: "text" }
  })
}

const AutoFormControl = defineComponent({
  name: "AutoFormControl",
  props: {
    form: { type: Object as PropType<FormStore>, required: true },
    field: { type: Object as PropType<AutoFormField>, required: true },
    id: { type: String, required: true },
  },
  setup(props) {
    // SAFETY: describeFormFields() reads the keys from the schema of this form.
    const store = useField(props.form, { path: [props.field.key] as never })
    return () => {
      const { field, id } = props
      const errorId = `${id}-error`
      const helpId = `${id}-help`
      const described = [field.description ? helpId : undefined, store.errors ? errorId : undefined].filter(Boolean).join(" ") || undefined
      const common = {
        ...store.props,
        id,
        required: field.required,
        "aria-invalid": store.errors ? "true" : undefined,
        "aria-describedby": described,
      }
      const value: unknown = store.input
      let control: VNode
      if (field.control === "checkbox") {
        control = h("input", { ...common, type: "checkbox", checked: value === true, onChange: (event: Event) => { store.input = (event.target as HTMLInputElement).checked as never } })
      }
      else if (field.control === "select") {
        // Each option is its index, so a number option goes back to the form as a number.
        const options = field.options ?? []
        const selected = options.indexOf(value as string | number)
        control = h("select", { ...common, value: selected < 0 ? "" : String(selected), onChange: (event: Event) => { const index = (event.target as HTMLSelectElement).value; store.input = (index === "" ? undefined : options[Number(index)]) as never } }, [
          h("option", { value: "", disabled: true }, "Choose one"),
          ...options.map((option, index) => h("option", { value: String(index) }, String(option))),
        ])
      }
      else {
        const tag = field.control === "textarea" ? "textarea" : "input"
        control = h(tag, {
          ...common,
          ...(tag === "input" ? { type: field.inputType ?? "text" } : { rows: 5 }),
          ...(field.maxLength ? { maxlength: field.maxLength } : {}),
          ...(field.inputType === "email" ? { autocomplete: "email", spellcheck: false } : {}),
          value: value ?? "",
          onInput: (event: Event) => {
            const raw = (event.target as HTMLInputElement).value
            store.input = (field.inputType === "number" ? (raw === "" ? undefined : Number(raw)) : raw) as never
          },
        })
      }
      return h("div", { "data-field": field.key }, [
        field.control === "checkbox"
          ? h("label", { for: id }, [control, " ", field.label])
          : [h("label", { for: id }, field.label), control],
        field.description ? h("p", { id: helpId, "data-help": "" }, field.description) : null,
        store.errors ? h("p", { id: errorId, "data-error": "", role: "alert" }, store.errors[0]) : null,
      ])
    }
  },
})

/**
 * A whole form from a Valibot object schema: labels, inputs, the honeypot, field errors, a submit button, and a
 * message after it is sent. It draws plain elements with `data-*` attributes, so the app styles it.
 *
 * ```vue
 * <AutoForm name="contact" :schema="ContactSchema" />
 * ```
 */
export const AutoForm = defineComponent({
  name: "AutoForm",
  props: {
    /** The form name: the file `server/forms/<name>.ts`. */
    name: { type: String, required: true },
    /** The Valibot object schema of the form, the same that `defineForm()` uses. */
    schema: { type: Object as PropType<FormSchema>, required: true },
    submitLabel: { type: String, default: "Send" },
    sentMessage: { type: String, default: "Thanks. Your message was sent." },
    /** The honeypot field of `defineForm()`. `false` leaves it out. */
    honeypot: { type: [String, Boolean] as PropType<string | false>, default: "website" },
    anchor: { type: Object as PropType<FormAnchor>, default: undefined },
    base: { type: String, default: undefined },
  },
  emits: { sent: (id: string | true) => Boolean(id) },
  setup(props, { emit, slots }) {
    // An unchecked checkbox is `false`, not missing, so a required boolean validates.
    const form = useForm({ schema: props.schema, emptyInput: { boolean: false } })
    const fields = computed(() => describeFormFields(props.schema))
    const trap = ref("")
    const { send, sent } = useFormSubmit(props.name, form, {
      get anchor() { return props.anchor },
      get base() { return props.base },
    } as SubmitFormOptions)
    const onSubmit = handleSubmit(form, async () => {
      await send(props.honeypot ? { [props.honeypot]: trap.value } : {})
      if (sent.value) emit("sent", sent.value)
    })
    const prefix = `vitehub-form-${props.name}`
    return () => h("form", { "data-vitehub-form": props.name, novalidate: true, onSubmit }, [
      ...fields.value.map(field => h(AutoFormControl, { key: field.key, form, field, id: `${prefix}-${field.key}` })),
      props.honeypot
        ? h("input", {
            name: props.honeypot,
            value: trap.value,
            onInput: (event: Event) => { trap.value = (event.target as HTMLInputElement).value },
            tabindex: -1,
            autocomplete: "off",
            "aria-hidden": "true",
            style: "position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden",
          })
        : null,
      form.errors ? h("p", { "data-error": "", role: "alert" }, form.errors[0]) : null,
      sent.value ? h("p", { "data-sent": "", role: "status" }, slots.sent?.() ?? props.sentMessage) : null,
      h("button", { type: "submit", disabled: form.isSubmitting, "aria-busy": form.isSubmitting ? "true" : undefined }, form.isSubmitting ? `${props.submitLabel}…` : props.submitLabel),
    ])
  },
})
