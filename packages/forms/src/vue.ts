import { computed, defineComponent, getCurrentInstance, h, nextTick, onMounted, ref, useId } from "vue"

import { FormSubmitError, fieldErrors, formRoute, submitForm } from "./client.ts"
import { formsDiagnostics } from "./errors.ts"
import { checkForm, coerceFormFields, formFields, isLongText } from "./fields.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { PropType, Ref, VNode } from "vue"
import type { FormAnchor, FormFieldErrors, SubmitFormOptions } from "./client.ts"
import type { SchemaNode } from "./schema.ts"

export { FormSubmitError, fieldErrors, formRoute, submitForm } from "./client.ts"
export type { FormAnchor, FormFieldErrors, FormIssue, SubmitFormOptions } from "./client.ts"

/** The part of a Vue Router that `AutoForm` uses, so it needs no `vue-router` import. */
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

/** The first control of the form, in page order, that has one of these names. */
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
    // `currentTarget` is null after the first await.
    const form = event.currentTarget
    if (!(form instanceof HTMLFormElement)) return
    if (await send(form, event.submitter)) form.reset()
  }
  return { submit, ...state }
}

/** The state of `useFormAction()`, with `send()` for a form element that the caller already holds, as `AutoForm` does. */
function formSender(name: string, options: SubmitFormOptions) {
  const errors = ref<FormFieldErrors>({})
  const sent = ref<string | true>()
  const error = ref<FormSubmitError>()
  const pending = ref(false)
  /** Sends the controls of `form`. True after a success. */
  async function send(form: HTMLFormElement, submitter: HTMLElement | null): Promise<boolean> {
    // A second click on a slow network would store the message twice.
    if (pending.value) return false
    pending.value = true
    sent.value = undefined
    error.value = undefined
    errors.value = {}
    // The submitter's own name and value count, as in a browser post. `FormData` throws for a submitter of another form.
    const own = submitter && "form" in submitter && submitter.form === form ? submitter : null
    const [failure, data] = await submitForm(name, new FormData(form, own), options).finally(() => { pending.value = false })
    if (!failure) {
      sent.value = data.id ?? true
      return true
    }
    error.value = failure
    errors.value = fieldErrors(failure)
    // After the render, so the field already points to its error through `aria-describedby` when focus reads it.
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

/** The message of a failure for the whole form: an issue without a path, or the message when no field has an issue. */
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
    // Any value of the field, so no runtime type check.
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
        // The option text is its value, so a post without JavaScript sends it. A number option goes back as a number.
        const options = field.options ?? []
        control = h("select", { ...common, value: value === undefined || value === null ? "" : String(value), onChange: (event: Event) => { const text = (event.target as HTMLSelectElement).value; emit("edit", options.find(option => String(option) === text)) } }, [
          // An optional select can go back to empty.
          // `selected` on the options, since a server-rendered select has no value: the browser would show the first option.
          h("option", { value: "", disabled: field.required, selected: value === undefined || value === null || value === "" }, "Choose one"),
          ...options.map(option => h("option", { value: String(option), selected: value !== undefined && value !== null && String(option) === String(value) }, String(option))),
        ])
      }
      else {
        const tag = field.control === "textarea" ? "textarea" : "input"
        control = h(tag, {
          ...common,
          ...(tag === "input" ? { type: field.inputType ?? "text" } : { rows: 5 }),
          // The browser checks a number input before the app runs. Its default step of 1 would refuse 1.5.
          ...(field.inputType === "number" ? { step: "any" } : {}),
          // The browser checks the lengths before the app runs, so a short message is not lost to a round trip.
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
        // No alert role: focus moves to the first invalid field, which reads its error through `aria-describedby`.
        error ? h("p", { id: errorId, "data-error": "" }, error) : null,
      ])
    }
  },
})

/** The first values of the fields: the default of the schema, else `false` for a checkbox, so a required boolean validates. */
function initialValues(schema: unknown, fields: readonly AutoFormField[]): Record<string, unknown> {
  const entries = (schema as SchemaNode).entries ?? {}
  return Object.fromEntries(fields.map((field) => {
    let node: SchemaNode | undefined = entries[field.key]
    let value: unknown
    while (node) {
      const fallback = node.default
      // Valibot calls a default function with no dataset when it reads the default of a schema.
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
    /** The form name: the file `server/forms/<name>.ts`. */
    name: { type: String, required: true },
    /** The Valibot object schema of the form, the same that `defineForm()` uses. */
    schema: { type: Object as PropType<StandardSchemaV1<Record<string, unknown>>>, required: true },
    submitLabel: { type: String, default: "Send" },
    sentMessage: { type: String, default: "Thanks. Your message was sent." },
    /**
     * The `form` query of the page after a post without JavaScript, such as `contact.sent` or `contact.error`. Pass it
     * from the route, so a server-rendered page shows the result before JavaScript runs. Without it, `AutoForm` reads
     * the query when it mounts. A result of another form is ignored.
     */
    result: { type: String, default: undefined },
    /** Shown after a post without JavaScript that the server refused. */
    errorMessage: { type: String, default: "The message was not sent. Check the form and try again." },
    /** The honeypot field of `defineForm()`. `false` leaves it out. */
    honeypot: { type: [String, Boolean] as PropType<string | false>, default: "website" },
    anchor: { type: Object as PropType<FormAnchor>, default: undefined },
    base: { type: String, default: undefined },
  },
  emits: { sent: (id: string | true) => Boolean(id) },
  setup(props, { emit, slots }) {
    const fields = computed(() => describeFormFields(props.schema))
    const values = ref(initialValues(props.schema, fields.value))
    const trap = ref("")
    const { send, sent, errors: serverErrors, error: serverError, pending, clear } = formSender(props.name, {
      get anchor() { return props.anchor },
      get base() { return props.base },
    } as SubmitFormOptions)
    // The errors of the check in the browser, which runs the schema on the same values that the server reads.
    const checkErrors = ref<FormFieldErrors>({})
    const formError = ref<string>()
    // True while the check in the browser runs, so the button shows that it is busy while a slow check runs.
    const checking = ref(false)
    // After the first submit, every edit checks the form again, so a corrected field loses its error as the user types.
    let submitted = false
    // Counts the edits, so a check that started before an edit does not send the form.
    let edits = 0
    // Counts the checks, so the result of an older check does not replace a newer one.
    let checks = 0
    const formElement = ref<HTMLFormElement>()
    // A post without JavaScript comes back with `?form=<name>.sent` or `?form=<name>.error`. Show it in the status region.
    const resultOf = (value: string | null | undefined): "sent" | "error" | undefined => value === `${props.name}.sent` ? "sent" : value === `${props.name}.error` ? "error" : undefined
    const returned = ref(resultOf(props.result))
    // The browser checks `required` and `type` itself until the app runs, so a post without JavaScript is checked too.
    const mounted = ref(false)
    const statusElement = ref<HTMLElement>()
    // Vue Router keeps its own copy of the address, so the query goes through it when the app has one.
    const router = getCurrentInstance()?.appContext.config.globalProperties.$router as QueryRouter | undefined
    onMounted(async () => {
      mounted.value = true
      const url = globalThis.location ? new URL(globalThis.location.href) : undefined
      returned.value ??= resultOf(url?.searchParams.get("form"))
      // The page loads at the top after the redirect, and initial text is not announced. Move focus to the result.
      // Not when the visitor is already in a field: that would close the keyboard on a phone.
      const active = globalThis.document?.activeElement
      if (returned.value && (!active || active === document.body)) statusElement.value?.focus()
      // A reload, a shared link, or a later navigation back must not show the result again.
      if (url && resultOf(url.searchParams.get("form"))) {
        if (router) {
          // An app-shell form can mount before the router reaches the requested page.
          await router.isReady()
          const route = router.currentRoute.value
          // A guard may have redirected to a page with another form's result while we waited.
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
    /**
     * Runs the schema on the controls of the form, decoded as the server decodes a post: the same values that the
     * server checks. A check that throws, such as a failed request of an async check, is a message for the whole form.
     */
    async function check(form: HTMLFormElement): Promise<FormSubmitError | undefined> {
      const input: Record<string, unknown> = {}
      for (const [key, value] of new FormData(form)) {
        if (key !== props.honeypot && typeof value === "string") input[key] = value
      }
      coerceFormFields(props.schema, input)
      const [failure] = await checkForm(props.schema, input).catch((error: unknown) => [new FormSubmitError(error instanceof Error ? error.message : String(error), 0)] as const)
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
    // The button stays focusable while it sends, so a second submit is ignored here instead.
    const busy = () => checking.value || pending.value
    const onSubmit = async (event: SubmitEvent) => {
      event.preventDefault()
      // `currentTarget` is null after the first await.
      const form = event.currentTarget
      if (!(form instanceof HTMLFormElement) || busy()) return
      // A new send replaces the result of an earlier post without JavaScript.
      returned.value = undefined
      submitted = true
      checking.value = true
      const edited = edits
      // A check that an earlier edit started must not replace the result of this one.
      checks++
      const failure = await check(form)
      checking.value = false
      // An edit during the check makes this attempt old. A fresh click sends the current values.
      if (edited !== edits) return
      show(failure)
      if (failure) {
        // After the render, so the field already points to its error through `aria-describedby` when focus reads it.
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
    // One id for each instance, so two forms of one name on a page keep their labels apart.
    const prefix = `vitehub-form-${props.name}-${useId()}`
    // `method` and `action` post the form to its route before the app hydrates, or without JavaScript.
    return () => h("form", { "data-vitehub-form": props.name, method: "post", action: formRoute(props.name, props.base), novalidate: mounted.value, onSubmit, ref: formElement }, [
      ...fields.value.map(field => h(AutoFormControl, {
        key: field.key,
        field,
        id: `${prefix}-${field.key}`,
        value: values.value[field.key],
        error: checkErrors.value[field.key] ?? serverErrors.value[field.key],
        onEdit: (value: unknown) => edit(field.key, value),
      })),
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
      formError.value ? h("p", { "data-error": "", role: "alert" }, formError.value) : null,
      // The live region is always there, so screen readers announce the text when it appears.
      h("p", { "data-sent": sent.value || returned.value === "sent" ? "" : undefined, "data-error": !sent.value && returned.value === "error" ? "" : undefined, role: "status", tabindex: "-1", ref: statusElement }, status()),
      // The label stays the same while it sends, so the button keeps its width. `aria-busy` tells that it sends.
      h("button", { type: "submit", "aria-disabled": busy() ? "true" : undefined, "aria-busy": busy() ? "true" : undefined }, props.submitLabel),
    ])
  },
})
