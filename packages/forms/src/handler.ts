import { back, fail, guardRequest, json } from "./guard.ts"

import { coerceFormFields } from "./schema.ts"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { FormDefinition, FormEmailMessage, FormIssue, FormServices, FormSubmission, FormUser } from "./types.ts"

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

function issuePath(path: StandardSchemaV1.Issue["path"]): (string | number)[] {
  return (path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment
    return typeof key === "number" ? key : String(key)
  })
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
  const caller: { user: FormUser | null } = { user: null }
  const [stopped, guarded] = await guardRequest(request, {
    key: `form:${name}`,
    name,
    ...(options.origins ? { origins: options.origins } : {}),
    ...(options.honeypot !== undefined ? { honeypot: options.honeypot } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
    // Before the rate limit and body parsing: a refused sender uses no budget, and `authorize` can read the bounded body.
    check: async (incoming) => {
      caller.user = services.identify ? await services.identify(incoming) : null
      if (!options.authorize || await options.authorize({ request: incoming, user: caller.user })) return undefined
      return caller.user ? { status: 403, message: "You may not send this form." } : { status: 401, message: "Sign in to send this form." }
    },
  }, services)
  if (stopped) return stopped
  const { body: fields, page, anchor, html } = guarded
  const { user } = caller
  // A browser form without JavaScript goes back to its page on every failure, not to a JSON answer.
  const stop = (status: number, message: string) => html ? back(request, page, "error", name) : fail(status, message)

  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") coerceFormFields(options.schema, fields)
  const result = await options.schema["~standard"].validate(fields)
  if (result.issues) {
    if (html) return back(request, page, "error", name)
    return json(400, { message: "Check the form and try again.", issues: result.issues.map((issue): FormIssue => ({ message: issue.message, path: issuePath(issue.path) })) })
  }

  const data = jsonData(result.value)
  if (!data) {
    if (html) return back(request, page, "error", name)
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

  return html ? back(request, page, "sent", name) : json(201, { id: submission.id })
}
