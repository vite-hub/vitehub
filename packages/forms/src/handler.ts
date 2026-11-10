import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

import { coerceFormFields } from "./schema.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { FormAnchor, FormDefinition, FormEmailMessage, FormIssue, FormServices, FormSubmission, FormUser } from "./types.ts"

const defaultRateLimit = { limit: 5, window: "1m" }
const defaultMaxBytes = 64 * 1024
const pageField = "_page"
const anchorField = "_anchor"

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
}

function fail(status: number, message: string, headers?: Record<string, string>): Response {
  return json(status, { message }, headers)
}

type BodyKind = "json" | "form"

function bodyKind(request: Request): BodyKind | undefined {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (type === "application/json") return "json"
  if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") return "form"
  return undefined
}

/** Reads at most `limit` bytes, so a large body without `content-length` stops early. */
async function readText(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > limit) return undefined
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function readBody(request: Request, kind: BodyKind, text: string): Promise<Record<string, unknown> | undefined> {
  if (kind === "json") {
    try {
      const value: unknown = JSON.parse(text)
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    }
    catch {
      return undefined
    }
  }
  let form: FormData | URLSearchParams
  try {
    form = request.headers.get("content-type")?.toLowerCase().startsWith("multipart/")
      ? await new Response(text, { headers: { "content-type": request.headers.get("content-type")! } }).formData()
      : new URLSearchParams(text)
  }
  catch {
    // A multipart body without its boundary, or a broken one.
    return undefined
  }
  const body: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") return undefined
    const previous = body[key]
    body[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value]
  }
  return body
}

/** Keep schema output in the same JSON representation for hooks, notifications, and both stores. */
function jsonData<T>(value: T): { value: T } | undefined {
  const ancestors = new Set<object>()
  const valid = (value: unknown): boolean => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true
    if (typeof value === "number") return Number.isFinite(value)
    if (typeof value !== "object" || ancestors.has(value)) return false
    const prototype: unknown = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
    ancestors.add(value)
    const values: unknown[] = Array.isArray(value) ? Array.from(value) : Object.values(value)
    const accepted = values.every(valid)
    ancestors.delete(value)
    return accepted
  }
  try {
    return valid(value) ? { value: JSON.parse(JSON.stringify(value)) as T } : undefined
  }
  catch {
    return undefined
  }
}

function appPath(value: unknown, request: Request): string | null {
  const raw = typeof value === "string" ? value : request.headers.get("referer")
  if (!raw) return null
  try {
    const origin = forwardedRequestOrigin(request)
    const url = new URL(raw, origin)
    if (url.origin !== origin) return null
    // One leading slash: `//evil.test` would be a link to another site.
    return `${url.pathname.replace(/^\/+/, "/")}${url.search}`.slice(0, 2000)
  }
  catch {
    return null
  }
}

function readAnchor(value: unknown): FormAnchor | null {
  let input = value
  if (typeof input === "string") {
    try {
      input = JSON.parse(input)
    }
    catch {
      return null
    }
  }
  if (!input || typeof input !== "object") return null
  const field = (key: string, limit: number) => {
    const raw: unknown = Reflect.get(input, key)
    return typeof raw === "string" ? raw.slice(0, limit) : ""
  }
  const selector = field("selector", 500)
  return selector ? { selector, exact: field("exact", 1000), prefix: field("prefix", 64), suffix: field("suffix", 64) } : null
}

function issuePath(path: StandardSchemaV1.Issue["path"]): (string | number)[] {
  return (path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment
    return typeof key === "number" ? key : String(key)
  })
}

function wantsPage(request: Request, kind: BodyKind): boolean {
  return kind === "form" && (request.headers.get("accept") ?? "").includes("text/html")
}

/** A browser form without JavaScript goes back to its page, with `?form=sent` or `?form=error`. */
function back(request: Request, page: string | null, result: "sent" | "error"): Response {
  const url = new URL(page ?? "/", request.url)
  url.searchParams.set("form", result)
  return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, "cache-control": "no-store" } })
}

function emailText(name: string, submission: FormSubmission): string {
  const lines = Object.entries(submission.data && typeof submission.data === "object" ? submission.data : { value: submission.data })
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
  if (submission.page) lines.push(`page: ${submission.page}`)
  if (submission.anchor?.exact) lines.push(`selected text: ${submission.anchor.exact}`)
  if (submission.user) lines.push(`user: ${submission.user.name ?? submission.user.id}${submission.user.email ? ` <${submission.user.email}>` : ""}`)
  return [`New message from the ${name} form.`, "", ...lines].join("\n")
}

function emailMessage<TSchema extends StandardSchemaV1>(name: string, definition: FormDefinition<TSchema>, submission: FormSubmission<StandardSchemaV1.InferOutput<TSchema>>): FormEmailMessage | undefined {
  const notify = definition.options.notify?.email
  if (!notify) return undefined
  const { data } = submission
  const subject = typeof notify.subject === "function" ? notify.subject(data) : notify.subject ?? `New ${name} form message`
  const replyTo: unknown = notify.replyTo ? data[notify.replyTo] : undefined
  return {
    to: notify.to,
    ...(notify.from ? { from: notify.from } : {}),
    ...(typeof replyTo === "string" && replyTo.includes("@") ? { replyTo } : {}),
    subject,
    text: emailText(name, submission),
  }
}

/**
 * Answers one form submission: `POST` with a JSON, URL-encoded, or multipart body. It returns 201 with the id, 400
 * with `issues`, or the status of the check that stopped it. A browser form without JavaScript gets a 303 back to its
 * page.
 */
export async function handleFormRequest<TSchema extends StandardSchemaV1>(name: string, definition: FormDefinition<TSchema>, request: Request, services: FormServices = {}): Promise<Response> {
  const { options } = definition
  if (request.method !== "POST") return fail(405, "Use POST.", { allow: "POST" })
  const kind = bodyKind(request)
  if (!kind) return fail(415, "Send JSON or form data.")
  const origin = request.headers.get("origin")
  // Behind a proxy that ends TLS, `request.url` is `http:` while the browser sends its `https:` origin.
  if (origin && origin !== forwardedRequestOrigin(request) && !options.origins?.includes(origin)) return fail(403, "This origin may not send this form.")
  // A browser form without JavaScript goes back to its page on every failure, not to a JSON answer.
  let page = appPath(undefined, request)
  const stop = (status: number, message: string, headers?: Record<string, string>) => wantsPage(request, kind) ? back(request, page, "error") : fail(status, message, headers)

  const user: FormUser | null = services.identify ? await services.identify(request) : null
  if (options.authorize && !await options.authorize({ request, user })) {
    return user ? stop(403, "You may not send this form.") : stop(401, "Sign in to send this form.")
  }

  const rateLimit = options.rateLimit === false ? undefined : options.rateLimit ?? defaultRateLimit
  if (rateLimit && services.rateLimit) {
    const decision = await services.rateLimit(request, `form:${name}`, rateLimit)
    if (!decision.allowed) return stop(429, "Too many messages. Try again later.", decision.retryAfter ? { "retry-after": String(Math.ceil(decision.retryAfter)) } : undefined)
  }

  const text = await readText(request, options.maxBytes ?? defaultMaxBytes)
  if (text === undefined) return stop(413, "The message is too large.")
  const body = await readBody(request, kind, text)
  if (!body) return stop(400, "The body is not a form.")
  page = appPath(body[pageField], request)
  const honeypot = options.honeypot === false ? undefined : options.honeypot ?? "website"
  const trap = honeypot ? body[honeypot] : undefined
  // A filled honeypot gets the answer of a success, so a bot does not try again.
  if (typeof trap === "string" && trap.trim()) return wantsPage(request, kind) ? back(request, page, "sent") : json(202, { ok: true })
  const anchor = readAnchor(body[anchorField])
  const fields = Object.fromEntries(Object.entries(body).filter(([key]) => key !== pageField && key !== anchorField && key !== honeypot))
  if (kind === "form") coerceFormFields(options.schema, fields)

  const result = await options.schema["~standard"].validate(fields)
  if (result.issues) {
    if (wantsPage(request, kind)) return back(request, page, "error")
    return json(400, { message: "Check the form and try again.", issues: result.issues.map((issue): FormIssue => ({ message: issue.message, path: issuePath(issue.path) })) })
  }

  const data = jsonData(result.value)
  if (!data) {
    if (wantsPage(request, kind)) return back(request, page, "error")
    return json(400, { message: "Check the form and try again.", issues: [{ message: "The form schema must return JSON data: plain objects, arrays, strings, finite numbers, booleans, or null.", path: [] }] })
  }
  const store = options.store === false ? undefined : services.store
  if (options.store !== false && !store) return stop(503, "This form cannot store messages now.")

  const now = services.now?.() ?? Date.now()
  const submission: FormSubmission<StandardSchemaV1.InferOutput<TSchema>> = {
    id: services.id?.() ?? crypto.randomUUID(),
    form: name,
    data: data.value,
    page,
    anchor,
    user,
    status: "open",
    createdAt: now,
    updatedAt: now,
  }

  if (options.onSubmit) {
    const answer = await options.onSubmit(submission, { request })
    if (answer instanceof Response) return answer
  }

  const message = emailMessage(name, definition, submission)
  if (store) await store.insert(submission)
  if (message && store) {
    // The submission is safe in the inbox, so a notification failure does not fail the request.
    if (services.email) {
      const email = services.email
      const notified = Promise.resolve().then(() => email(message)).catch(error => services.log?.(`[vitehub] The ${name} form stored a submission but could not send its email.`, error))
      if (services.waitUntil) services.waitUntil(notified)
      else await notified
    }
    else services.log?.(`[vitehub] The ${name} form stored a submission but the app cannot send email.`, undefined)
  }
  else if (message) {
    if (!services.email) return stop(503, "This form cannot send messages now.")
    try {
      await services.email(message)
    }
    catch (error) {
      services.log?.(`[vitehub] The ${name} form could not send its email.`, error)
      return stop(502, "The message could not be sent. Try again later.")
    }
  }

  return wantsPage(request, kind) ? back(request, page, "sent") : json(201, { id: submission.id })
}
