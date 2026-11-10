import { focus, getInput, handleSubmit, reset, setErrors, useField, useForm } from "@formisch/vue"
import { computed, defineComponent, h, nextTick, onMounted, ref, useId } from "vue"

import { formRoute, submitForm } from "./client.ts"
import { unwrap } from "./schema.ts"

import type { FormSchema, FormStore } from "@formisch/vue"
import type { PropType, Ref, VNode } from "vue"
import type { FormAnchor, FormSubmitError, SubmitFormOptions } from "./client.ts"
import type { SchemaNode } from "./schema.ts"

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
    // Move focus to the first field with a server issue, as Formisch does for its own validation.
    const first = failure.issues.find(issue => issue.path.length)
    // After the render, so the field already points to its error through `aria-describedby` when focus reads it.
    if (first) {
      await nextTick()
      ;(focus as (form: FormStore<TSchema>, config: { path: (string | number)[] }) => void)(form, { path: first.path })
    }
    const message = formIssues[0] ?? (failure.issues.length ? undefined : failure.message)
    if (message) setErrors(form, { errors: [message, ...formIssues.slice(1)] })
  }
  return { send, sent, error }
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

/**
 * The fields of a Valibot object schema, in order: a string becomes a text, email, or url input, or a textarea when it
 * is long; a number becomes a number input; a boolean a checkbox; a picklist or enum a select. `v.title()` and
 * `v.description()` set the label and the help text.
 */
export function describeFormFields(schema: unknown): AutoFormField[] {
  const root = schema as SchemaNode
  if (root?.type !== "object" || !root.entries) throw new TypeError("[vitehub] AutoForm needs a Valibot object schema, such as v.object({ message: v.string() }).")
  return Object.entries(root.entries).map(([key, entry]) => {
    // `v.pipe(v.optional(v.string()), v.title("Name"))` keeps its title on the outer pipe.
    const { node, required, actions } = unwrap(entry)
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
        name: field.key,
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
        // The option text is its value, so a post without JavaScript sends it. A number option goes back as a number.
        const options = field.options ?? []
        control = h("select", { ...common, value: value === undefined || value === null ? "" : String(value), onChange: (event: Event) => { const text = (event.target as HTMLSelectElement).value; store.input = options.find(option => String(option) === text) as never } }, [
          // An optional select can go back to empty.
          h("option", { value: "", disabled: field.required }, "Choose one"),
          ...options.map(option => h("option", { value: String(option) }, String(option))),
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
        // No alert role: focus moves to the first invalid field, which reads its error through `aria-describedby`.
        store.errors ? h("p", { id: errorId, "data-error": "" }, store.errors[0]) : null,
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
    /**
     * The result of a post without JavaScript: `?form=sent` or `?form=error` of the page. Pass it from the route query,
     * so a server-rendered page shows it before JavaScript runs. Without it, `AutoForm` reads the query when it mounts.
     */
    result: { type: String as PropType<"sent" | "error">, default: undefined },
    /** Shown after a post without JavaScript that the server refused. */
    errorMessage: { type: String, default: "The message was not sent. Check the form and try again." },
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
    // A post without JavaScript comes back with `?form=sent` or `?form=error`. Show it in the status region.
    const returned = ref<"sent" | "error" | undefined>(props.result === "sent" || props.result === "error" ? props.result : undefined)
    onMounted(() => {
      if (returned.value) return
      const result = new URLSearchParams(globalThis.location?.search).get("form")
      if (result === "sent" || result === "error") returned.value = result
    })
    const status = () => {
      if (sent.value || returned.value === "sent") return slots.sent?.() ?? props.sentMessage
      return returned.value === "error" ? props.errorMessage : undefined
    }
    // The event form of `handleSubmit()`, so it cancels the browser post.
    const submit = handleSubmit(form, async (_output: unknown, _event: SubmitEvent) => {
      await send(props.honeypot ? { [props.honeypot]: trap.value } : {})
      if (sent.value) emit("sent", sent.value)
    })
    // The button stays focusable while it sends, so a second submit is ignored here instead.
    const onSubmit = (event: SubmitEvent) => {
      if (!form.isSubmitting) {
        // A new send replaces the result of an earlier post without JavaScript.
        returned.value = undefined
        return submit(event)
      }
      event.preventDefault()
    }
    // One id for each instance, so two forms of one name on a page keep their labels apart.
    const prefix = `vitehub-form-${props.name}-${useId()}`
    // `method` and `action` post the form to its route before the app hydrates, or without JavaScript.
    return () => h("form", { "data-vitehub-form": props.name, method: "post", action: formRoute(props.name, props.base), novalidate: true, onSubmit }, [
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
      // The live region is always there, so screen readers announce the text when it appears.
      h("p", { "data-sent": sent.value || returned.value === "sent" ? "" : undefined, "data-error": !sent.value && returned.value === "error" ? "" : undefined, role: "status" }, status()),
      // The label stays the same while it sends, so the button keeps its width. `aria-busy` tells that it sends.
      h("button", { type: "submit", "aria-disabled": form.isSubmitting ? "true" : undefined, "aria-busy": form.isSubmitting ? "true" : undefined }, props.submitLabel),
    ])
  },
})
