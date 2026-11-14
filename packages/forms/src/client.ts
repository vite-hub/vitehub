/** One validation problem. `path` is empty for a problem of the whole form. */
export interface FormIssue {
  message: string
  path: (string | number)[]
}

/** Why a submission failed: the HTTP status, the server message, and, for a 400, the problem of each field. */
export class FormSubmitError extends Error {
  override readonly name = "FormSubmitError"
  readonly status: number
  readonly issues: FormIssue[]
  constructor(message: string, status: number, issues: FormIssue[] = []) {
    super(message)
    this.status = status
    this.issues = issues
  }
}

/** The part of the page that the sender pointed at: an element and a W3C text quote, as a Comments text anchor. */
export interface FormAnchor {
  selector: string
  exact: string
  prefix: string
  suffix: string
}

export interface SubmitFormOptions {
  /** The route of the form. Default `/api/_vitehub/forms/<name>`, below the app base. */
  url?: string
  /** The app base, such as `/docs/`. Default `/`. */
  base?: string
  /** The page that the form is on. Default: the current path in a browser. */
  page?: string
  anchor?: FormAnchor
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** The route of a form, below the app base. */
export function formRoute(name: string, base = "/"): string {
  return `${base.endsWith("/") ? base : `${base}/`}api/_vitehub/forms/${encodeURIComponent(name)}`
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

/** The body of a submission: JSON keeps its types, and form data is decoded by the server, as a post without JavaScript. */
function requestBody(values: Record<string, unknown> | FormData, page: string | undefined, anchor: FormAnchor | undefined): { type: string, body: string } {
  if (!(values instanceof FormData)) {
    return { type: "application/json", body: JSON.stringify({ ...values, ...(page ? { _page: page } : {}), ...(anchor ? { _anchor: anchor } : {}) }) }
  }
  const params = new URLSearchParams()
  // Forms take text fields. A file input has no place in the stored JSON, so it is not sent.
  for (const [key, value] of values) if (typeof value === "string") params.append(key, value)
  if (page) params.set("_page", page)
  if (anchor) params.set("_anchor", JSON.stringify(anchor))
  return { type: "application/x-www-form-urlencoded", body: params.toString() }
}

/**
 * Sends the values of a form to its route. Returns `[undefined, { id }]`, or `[error]` where `error.issues` holds
 * the problem of each field for a 400. Pass `FormData` to send the controls of a `<form>`: the server decodes them
 * to the types of the schema, as it does for a post without JavaScript.
 */
export async function submitForm(name: string, values: Record<string, unknown> | FormData, options: SubmitFormOptions = {}): Promise<[FormSubmitError, undefined] | [undefined, { id?: string }]> {
  const here = (globalThis as { location?: { pathname: string, search: string } }).location
  const page = options.page ?? (here ? `${here.pathname}${here.search}` : undefined)
  const request = requestBody(values, page, options.anchor)
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(options.url ?? formRoute(name, options.base), {
      method: "POST",
      headers: { "content-type": request.type, accept: "application/json" },
      body: request.body,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  }
  catch (error) {
    return [new FormSubmitError(error instanceof Error ? error.message : "The message could not be sent.", 0), undefined]
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) {
    const id: unknown = body && typeof body === "object" ? Reflect.get(body, "id") : undefined
    return [undefined, typeof id === "string" ? { id } : {}]
  }
  const message: unknown = body && typeof body === "object" ? Reflect.get(body, "message") : undefined
  return [new FormSubmitError(typeof message === "string" ? message : `The form answered ${response.status}.`, response.status, readIssues(body)), undefined]
}
