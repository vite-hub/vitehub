import { computed, defineComponent, getCurrentInstance, h, nextTick, onMounted, ref, useId } from "vue"

import { fieldErrors, formSubmitError, formRoute, submitForm } from "./client.ts"
import { formsDiagnostics } from "./errors.ts"
import { checkForm, coerceFormFields, formFields, isLongText } from "./fields.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { PropType, Ref, VNode } from "vue"
import type { FormAnchor, FormFieldErrors, FormSubmitError, SubmitFormOptions } from "./client.ts"
import type { SchemaNode } from "./schema.ts"

export { fieldErrors, formRoute, submitForm } from "./client.ts"
export type { FormSubmitError } from "./client.ts"
export type { FormAnchor, FormFieldErrors, FormIssue, SubmitFormOptions } from "./client.ts"

interface QueryRouter {
  currentRoute: { value: { query: Record<string, unknown>, hash: string } }
  isReady: () => Promise<void>
  replace: (to: { query: Record<string, unknown>, hash: string }) => Promise<unknown>
}

/** What `useFormAction()` returns. */
export interface FormActionState {
  /**
   * Sends the controls of the form by their `name`: `<form @submit="submit">`. It cancels the browser post, so give
   * the form `method="post"` and `:action="formRoute(name)"` and it still works before the app loads.
   */
  submit: (event: SubmitEvent) => Promise<void>
  /** The server error of each field, by `name`, until the next send or `clear()`. */
  errors: Ref<FormFieldErrors>
  /** The id of the stored submission after a success. */
  sent: Ref<string | true | undefined>
  /** The last failure, such as the rate limit or a network error. `error.message` is the message for the whole form. */
  error: Ref<FormSubmitError | undefined>
  /** True while the form sends. */
  pending: Ref<boolean>
  /** Removes the error of one field, such as when the person edits it, or every error without a name. */
  clear: (name?: string) => void
}

function firstControl(form: HTMLFormElement, names: FormFieldErrors): HTMLElement | undefined {
  for (const element of form.elements) {
    if (element instanceof HTMLElement && "name" in element && typeof element.name === "string" && element.name in names) return element
  }
  return undefined
}

/**
 * Sends a native `<form>` to `server/forms/<name>.ts`. The server validates the form schema and answers a 400 with the
 * error of each field, which `errors` holds by the control's `name`. Focus moves to the first field with an error,
 * after it renders. A success resets the form.
 *
 * ```vue
 * <form method="post" :action="formRoute('contact')" @submit="submit">
 *   <Field name="email" :invalid="errors.email ? true : undefined">
 *     <Input type="email" required @value-change="clear('email')" />
 *     <FieldError v-if="errors.email" match>{{ errors.email }}</FieldError>
 *   </Field>
 * </form>
 * ```
 */
export function useFormAction(name: string, options: SubmitFormOptions = {}): FormActionState {
  const { send, ...state } = formSender(name, options)
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const form = event.currentTarget
    if (!(form instanceof HTMLFormElement)) return
    if (await send(form, event.submitter)) form.reset()
  }
  return { submit, ...state }
}

function formSender(name: string, options: SubmitFormOptions) {
  const errors = ref<FormFieldErrors>({})
  const sent = ref<string | true>()
  const error = ref<FormSubmitError>()
  const pending = ref(false)
  async function send(form: HTMLFormElement, submitter: HTMLElement | null): Promise<boolean> {
    if (pending.value) return false
    pending.value = true
    sent.value = undefined
    error.value = undefined
    errors.value = {}
    const own = submitter && "form" in submitter && submitter.form === form ? submitter : null
    const [failure, data] = await submitForm(name, new FormData(form, own), options).finally(() => { pending.value = false })
    if (!failure) {
      sent.value = data.id ?? true
      return true
    }
    error.value = failure
    errors.value = fieldErrors(failure)
    await nextTick()
    firstControl(form, errors.value)?.focus()
    return false
  }
  function clear(field?: string) {
    if (field === undefined) errors.value = {}
    else if (field in errors.value) errors.value = Object.fromEntries(Object.entries(errors.value).filter(([key]) => key !== field))
  }
  return { send, errors, sent, error, pending, clear }
}

function formMessage(failure: FormSubmitError | undefined): string | undefined {
  if (!failure) return undefined
  return failure.issues.find(issue => issue.path.length === 0)?.message ?? (failure.issues.length ? undefined : failure.message)
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
  minLength?: number
  maxLength?: number
}

/**
 * The fields of a Valibot object schema, in order, from `formFields()`: a string becomes a text, email, or url input,
 * or a textarea when it is long; a number becomes a number input; a boolean a checkbox; a picklist or enum a select.
 * `v.title()` and `v.description()` set the label and the help text. A field that no form can draw, such as a nested
 * object, throws `FORMS_FIELD_NOT_DRAWABLE`.
 */
export function describeFormFields(schema: unknown): AutoFormField[] {
  const root = schema as SchemaNode
  if (root?.type !== "object" || !root.entries) throw formsDiagnostics.FORMS_AUTOFORM_SCHEMA_INVALID()
  return formFields(schema as StandardSchemaV1).map((field) => {
    const { name: key, label, description, required, minLength, maxLength } = field
    const base: AutoFormField = { key, label, control: "input", required, ...(description ? { description } : {}), ...(minLength !== undefined ? { minLength } : {}), ...(maxLength !== undefined ? { maxLength } : {}) }
    if (field.type === "boolean") return { ...base, control: "checkbox", required: false }
    if (field.options) return { ...base, control: "select", options: field.options }
    if (field.type === "number" || field.type === "integer") return { ...base, inputType: "number" }
    if (field.format === "email") return { ...base, inputType: "email" }
    if (field.format === "uri") return { ...base, inputType: "url" }
    if (isLongText(field)) return { ...base, control: "textarea" }
    return { ...base, inputType: "text" }
  })
}

const AutoFormControl = defineComponent({
  name: "AutoFormControl",
  props: {
    field: { type: Object as PropType<AutoFormField>, required: true },
    id: { type: String, required: true },
    value: { type: null as unknown as PropType<unknown>, required: false },
    error: { type: String, default: undefined },
  },
  emits: { edit: (_value: unknown) => true },
  setup(props, { emit }) {
    return () => {
      const { field, id, value, error } = props
      const errorId = `${id}-error`
      const helpId = `${id}-help`
      const described = [field.description ? helpId : undefined, error ? errorId : undefined].filter(Boolean).join(" ") || undefined
      const common = {
        name: field.key,
        id,
        required: field.required,
        "aria-invalid": error ? "true" : undefined,
        "aria-describedby": described,
      }
      let control: VNode
      if (field.control === "checkbox") {
        control = h("input", { ...common, type: "checkbox", checked: value === true, onChange: (event: Event) => emit("edit", (event.target as HTMLInputElement).checked) })
      }
      else if (field.control === "select") {
        const options = field.options ?? []
        control = h("select", { ...common, value: value === undefined || value === null ? "" : String(value), onChange: (event: Event) => { const text = (event.target as HTMLSelectElement).value; emit("edit", options.find(option => String(option) === text)) } }, [
          h("option", { value: "", disabled: field.required, selected: value === undefined || value === null || value === "" }, "Choose one"),
          ...options.map(option => h("option", { value: String(option), selected: value !== undefined && value !== null && String(option) === String(value) }, String(option))),
        ])
      }
      else {
        const tag = field.control === "textarea" ? "textarea" : "input"
        control = h(tag, {
          ...common,
          ...(tag === "input" ? { type: field.inputType ?? "text" } : { rows: 5 }),
          ...(field.inputType === "number" ? { step: "any" } : {}),
          ...(field.minLength ? { minlength: field.minLength } : {}),
          ...(field.maxLength ? { maxlength: field.maxLength } : {}),
          ...(field.inputType === "email" ? { autocomplete: "email", spellcheck: false } : {}),
          value: value ?? "",
          onInput: (event: Event) => {
            const raw = (event.target as HTMLInputElement).value
            emit("edit", field.inputType === "number" ? (raw === "" ? undefined : Number(raw)) : raw)
          },
        })
      }
      return h("div", { "data-field": field.key }, [
        field.control === "checkbox"
          ? h("label", { for: id }, [control, " ", field.label])
          : [h("label", { for: id }, field.label), control],
        field.description ? h("p", { id: helpId, "data-help": "" }, field.description) : null,
        error ? h("p", { id: errorId, "data-error": "" }, error) : null,
      ])
    }
  },
})

/**
 * The honeypot field of `defineForm()`: an input that people do not see and bots fill. Put it inside your own `<form>`,
 * such as a Nuxt UI `UForm`. A form that `useFormAction()` sends reads it by its name. When you send an object with
 * `submitForm()`, bind it with `v-model` and send its value under the same name.
 *
 * ```vue
 * <form method="post" :action="formRoute('contact')" @submit="submit">
 *   <FormHoneypot />
 * </form>
 * ```
 */
export const FormHoneypot = defineComponent({
  name: "FormHoneypot",
  props: {
    name: { type: String, default: "website" },
    modelValue: { type: String, default: undefined },
  },
  emits: { "update:modelValue": (_value: string) => true },
  setup(props, { emit }) {
    const own = ref("")
    return () => h("input", {
      name: props.name,
      value: props.modelValue ?? own.value,
      onInput: (event: Event) => {
        const value = (event.target as HTMLInputElement).value
        own.value = value
        emit("update:modelValue", value)
      },
      tabindex: -1,
      autocomplete: "off",
      "aria-hidden": "true",
      style: "position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden",
    })
  },
})

function initialValues(schema: unknown, fields: readonly AutoFormField[]): Record<string, unknown> {
  const entries = (schema as SchemaNode).entries ?? {}
  return Object.fromEntries(fields.map((field) => {
    let node: SchemaNode | undefined = entries[field.key]
    let value: unknown
    while (node) {
      const fallback = node.default
      value = typeof fallback === "function" ? fallback() : fallback
      if (value !== undefined || !["optional", "nullish", "nullable", "exact_optional", "undefinedable"].includes(node.type)) break
      node = node.wrapped
    }
    if (value instanceof Promise) return [field.key, field.control === "checkbox" ? false : undefined]
    return [field.key, value === undefined && field.control === "checkbox" ? false : value]
  }))
}

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
    name: { type: String, required: true },
    schema: { type: Object as PropType<StandardSchemaV1<Record<string, unknown>>>, required: true },
    submitLabel: { type: String, default: "Send" },
    sentMessage: { type: String, default: "Thanks. Your message was sent." },
    result: { type: String, default: undefined },
    errorMessage: { type: String, default: "The message was not sent. Check the form and try again." },
    honeypot: { type: [String, Boolean] as PropType<string | false>, default: "website" },
    anchor: { type: Object as PropType<FormAnchor>, default: undefined },
    base: { type: String, default: undefined },
  },
  emits: { sent: (id: string | true) => Boolean(id) },
  setup(props, { emit, slots }) {
    const fields = computed(() => describeFormFields(props.schema))
    const values = ref(initialValues(props.schema, fields.value))
    const { send, sent, errors: serverErrors, error: serverError, pending, clear } = formSender(props.name, {
      get anchor() { return props.anchor },
      get base() { return props.base },
    } as SubmitFormOptions)
    const checkErrors = ref<FormFieldErrors>({})
    const formError = ref<string>()
    const checking = ref(false)
    let submitted = false
    let edits = 0
    let checks = 0
    const formElement = ref<HTMLFormElement>()
    const resultOf = (value: string | null | undefined): "sent" | "error" | undefined => value === `${props.name}.sent` ? "sent" : value === `${props.name}.error` ? "error" : undefined
    const returned = ref(resultOf(props.result))
    const mounted = ref(false)
    const statusElement = ref<HTMLElement>()
    const router = getCurrentInstance()?.appContext.config.globalProperties.$router as QueryRouter | undefined
    onMounted(async () => {
      mounted.value = true
      const url = globalThis.location ? new URL(globalThis.location.href) : undefined
      returned.value ??= resultOf(url?.searchParams.get("form"))
      const active = globalThis.document?.activeElement
      if (returned.value && (!active || active === document.body)) statusElement.value?.focus()
      if (url && resultOf(url.searchParams.get("form"))) {
        if (router) {
          await router.isReady()
          const route = router.currentRoute.value
          if (typeof route.query.form !== "string" || !resultOf(route.query.form)) return
          const { form: _form, ...query } = route.query
          await router.replace({ query, hash: route.hash })
        }
        else {
          url.searchParams.delete("form")
          history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`)
        }
      }
    })
    const status = () => {
      if (sent.value || returned.value === "sent") return slots.sent?.() ?? props.sentMessage
      return returned.value === "error" ? props.errorMessage : undefined
    }
    async function check(form: HTMLFormElement): Promise<FormSubmitError | undefined> {
      const input: Record<string, unknown> = {}
      for (const [key, value] of new FormData(form)) {
        if (key !== props.honeypot && typeof value === "string") input[key] = value
      }
      coerceFormFields(props.schema, input)
      const [failure] = await checkForm(props.schema, input).catch((error: unknown) => [formSubmitError(error instanceof Error ? error.message : String(error), 0)] as const)
      return failure
    }
    function show(failure: FormSubmitError | undefined) {
      checkErrors.value = fieldErrors(failure)
      formError.value = formMessage(failure)
    }
    async function checkAgain(form: HTMLFormElement) {
      const run = ++checks
      const failure = await check(form)
      if (run === checks) show(failure)
    }
    function edit(key: string, value: unknown) {
      values.value = { ...values.value, [key]: value }
      edits++
      clear(key)
      if (submitted && formElement.value) void checkAgain(formElement.value)
    }
    const busy = () => checking.value || pending.value
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault()
      const form = event.currentTarget
      if (!(form instanceof HTMLFormElement) || busy()) return
      returned.value = undefined
      submitted = true
      checking.value = true
      const edited = edits
      checks++
      const failure = await check(form)
      checking.value = false
      if (edited !== edits) return
      show(failure)
      if (failure) {
        await nextTick()
        firstControl(form, checkErrors.value)?.focus()
        return
      }
      const success = await send(form, event.submitter)
      formError.value = formMessage(serverError.value)
      if (!success || !sent.value) return
      values.value = initialValues(props.schema, fields.value)
      submitted = false
      emit("sent", sent.value)
    }
    const prefix = `vitehub-form-${props.name}-${useId()}`
    return () => h("form", { "data-vitehub-form": props.name, method: "post", action: formRoute(props.name, props.base), novalidate: mounted.value, onSubmit, ref: formElement }, [
      ...fields.value.map(field => h(AutoFormControl, {
        key: field.key,
        field,
        id: `${prefix}-${field.key}`,
        value: values.value[field.key],
        error: checkErrors.value[field.key] ?? serverErrors.value[field.key],
        onEdit: (value: unknown) => edit(field.key, value),
      })),
      props.honeypot ? h(FormHoneypot, { name: props.honeypot }) : null,
      formError.value ? h("p", { "data-error": "", role: "alert" }, formError.value) : null,
      h("p", { "data-sent": sent.value || returned.value === "sent" ? "" : undefined, "data-error": !sent.value && returned.value === "error" ? "" : undefined, role: "status", tabindex: "-1", ref: statusElement }, status()),
      h("button", { type: "submit", "aria-disabled": busy() ? "true" : undefined, "aria-busy": busy() ? "true" : undefined }, props.submitLabel),
    ])
  },
})
