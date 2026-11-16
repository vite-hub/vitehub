import { focus, getInput, reset, setErrors } from "@formisch/vue"
import { nextTick, ref } from "vue"

import { submitForm } from "./client.ts"

import type { FormSchema, FormStore } from "@formisch/vue"
import type { Ref } from "vue"
import type { FormSubmitError, SubmitFormOptions } from "./client.ts"

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
  let pending = false
  async function send(extra: Record<string, unknown> = {}) {
    // A second click on a slow network would store the message twice.
    if (pending) return
    pending = true
    sent.value = undefined
    error.value = undefined
    const [failure, data] = await submitForm(name, { ...getInput(form), ...extra }, options).finally(() => { pending = false })
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
