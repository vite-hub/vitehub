import { formsClientDiagnostics } from "./client-diagnostics.ts"
import type { Diagnostic } from "nostics"

/** One validation problem. `path` is empty for a problem of the whole form. */
export interface FormIssue {
  message: string
  path: (string | number)[]
}

/**
 * Why a submission failed: `FORMS_SUBMIT_INVALID` for a 400, with the problem of each field in `issues`, or
 * `FORMS_SUBMIT_FAILED`. `status` is the HTTP status, or 0 when the request got no answer.
 */
export type FormSubmitError = Diagnostic & { issues: FormIssue[], status: number }

/** The error of a failed submission, for the HTTP status of the answer. */
export function formSubmitError(reason: string, status: number, issues: FormIssue[] = []): FormSubmitError {
  const error = status === 400 ? formsClientDiagnostics.FORMS_SUBMIT_INVALID({ reason }) : formsClientDiagnostics.FORMS_SUBMIT_FAILED({ reason })
  return Object.assign(error, { issues, status })
}

/** The part of the page that the sender pointed at: an element and a W3C text quote, as a Comments text anchor. */
export interface FormAnchor {
  selector: string
  exact: string
  prefix: string
  suffix: string
}

export interface SubmitFormOptions {
  /** The route of the form. Default `/_vitehub/forms/<name>`, below the app base. */
  url?: string
  /** The app base, such as `/docs/`. Default `/`. */
  base?: string
  /** The page that the form is on. Default: the current path in a browser. */
  page?: string
  anchor?: FormAnchor
  fetch?: typeof fetch
  signal?: AbortSignal
  /**
   * The `Idempotency-Key` of this message: the server stores one message for each key. Default: a new key for each
   * message, kept for a retry with the same values after a failure, so a retry after a lost answer stores nothing new.
   */
  idempotencyKey?: string
}

/** The route of a form, below the app base. */
export function formRoute(name: string, base = "/"): string {
  return `${base.endsWith("/") ? base : `${base}/`}_vitehub/forms/${encodeURIComponent(name)}`
}

function readIssues(value: unknown): FormIssue[] {
  if (!value || typeof value !== "object") return []
  const issues: unknown = Reflect.get(value, "issues")
  if (!Array.isArray(issues)) return []
  return issues.flatMap((issue: unknown) => {
    if (!issue || typeof issue !== "object") return []
    const message: unknown = Reflect.get(issue, "message")
    const path: unknown = Reflect.get(issue, "path")
    return typeof message === "string" ? [{ message, path: Array.isArray(path) ? path.filter((key): key is string | number => typeof key === "string" || typeof key === "number") : [] }] : []
  })
}

/** The message of each field, by its `name`: `{ email: "Enter a valid email." }`. */
export type FormFieldErrors = Record<string, string>

/**
 * The first message of each field of a failed submission, by field name. A nested path joins with dots, such as
 * `address.city`. Issues of the whole form are left out: read `error.message` for them.
 */
export function fieldErrors(error: { issues: readonly FormIssue[] } | undefined): FormFieldErrors {
  const errors: FormFieldErrors = {}
  for (const issue of error?.issues ?? []) {
    const name = issue.path.join(".")
    if (name && !(name in errors)) errors[name] = issue.message
  }
  return errors
}

function requestBody(values: Record<string, unknown> | FormData, page: string | undefined, anchor: FormAnchor | undefined): { type: string, body: string } {
  if (!(values instanceof FormData)) {
    return { type: "application/json", body: JSON.stringify({ ...values, ...(page ? { _page: page } : {}), ...(anchor ? { _anchor: anchor } : {}) }) }
  }
  const params = new URLSearchParams()
  for (const [key, value] of values) if (typeof value === "string") params.append(key, value)
  if (page) params.set("_page", page)
  if (anchor) params.set("_anchor", JSON.stringify(anchor))
  return { type: "application/x-www-form-urlencoded", body: params.toString() }
}

const latestSends = new Map<string, { retry: { body: string, key: string } | undefined }>()

/**
 * Sends the values of a form to its route. Returns `[undefined, { id }]`, or `[error]` where `error.issues` holds
 * the problem of each field for a 400. Pass `FormData` to send the controls of a `<form>`: the server decodes them
 * to the types of the schema, as it does for a post without JavaScript.
 */
export async function submitForm(name: string, values: Record<string, unknown> | FormData, options: SubmitFormOptions = {}): Promise<[FormSubmitError, undefined] | [undefined, { id?: string }]> {
  const here = (globalThis as { location?: { pathname: string, search: string } }).location
  const page = options.page ?? (here ? `${here.pathname}${here.search}` : undefined)
  const request = requestBody(values, page, options.anchor)
  const url = options.url ?? formRoute(name, options.base)
  const previous = latestSends.get(url)?.retry
  const retry = previous?.body === request.body ? previous : undefined
  const key = options.idempotencyKey ?? retry?.key ?? globalThis.crypto?.randomUUID?.()
  const send = { retry: key === retry?.key ? retry : undefined }
  latestSends.set(url, send)
  const failed = (error: FormSubmitError): [FormSubmitError, undefined] => {
    if (latestSends.get(url) === send) {
      if (key) send.retry = { body: request.body, key }
      else latestSends.delete(url)
    }
    return [error, undefined]
  }
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": request.type, accept: "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: request.body,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
  catch (error) {
    return failed(formSubmitError(error instanceof Error ? error.message : "The message could not be sent.", 0))
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) {
    if (latestSends.get(url) === send) latestSends.delete(url)
    const id: unknown = body && typeof body === "object" ? Reflect.get(body, "id") : undefined
    return [undefined, typeof id === "string" ? { id } : {}]
  }
  const message: unknown = body && typeof body === "object" ? Reflect.get(body, "message") : undefined
  return failed(formSubmitError(typeof message === "string" ? message : `The form answered ${response.status}.`, response.status, readIssues(body)))
}
