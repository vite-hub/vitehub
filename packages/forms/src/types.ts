import type { StandardSchemaV1 } from "@standard-schema/spec"

/** Where a submission is in the owner's inbox. */
export type FormStatus = "open" | "done" | "spam"

/** The signed-in person who sent a submission. */
export interface FormUser {
  id: string
  name?: string
  email?: string
}

/** The part of the page that the sender pointed at, such as a selected sentence. */
export interface FormAnchor {
  /** A CSS selector of the element. */
  selector?: string
  /** The text that the sender selected. At most 1,000 characters. */
  text?: string
}

/** One message that a visitor sent through a form. */
export interface FormSubmission<TData = unknown> {
  id: string
  /** The form name, such as `contact`. */
  form: string
  /** The validated output of the form schema. */
  data: TData
  /** The app path that the form was on, such as `/pricing`. */
  page: string | null
  anchor: FormAnchor | null
  user: FormUser | null
  status: FormStatus
  /** Milliseconds since the epoch. */
  createdAt: number
  updatedAt: number
}

/** A fixed-window budget for each sender address. */
export interface FormRateLimit {
  limit: number
  /** A duration such as `30s`, `1m`, or `1h`. */
  window: string
}

/** The email that the owner gets for each submission. */
export interface FormEmailNotify<TData> {
  to: string | readonly string[]
  /** The sender address. Default: the `from` of the Email configuration. */
  from?: string
  subject?: string | ((data: TData) => string)
  /** The field that holds the sender's email, so a reply goes to them. */
  replyTo?: Extract<keyof TData, string>
}

/** What `defineForm()` sends after it stores a submission. */
export interface FormNotify<TData> {
  email?: FormEmailNotify<TData>
}

export interface FormAuthorizeContext {
  request: Request
  user: FormUser | null
}

export interface FormSubmitContext {
  request: Request
}

export interface DefineFormOptions<TSchema extends StandardSchemaV1> {
  /** Any Standard Schema: Valibot, Zod, ArkType. The server validates every submission with it. */
  schema: TSchema
  /** Who may send. Default: anyone. */
  authorize?: (context: FormAuthorizeContext) => boolean | Promise<boolean>
  /** Default `{ limit: 5, window: "1m" }` for each sender address. `false` turns it off. */
  rateLimit?: FormRateLimit | false
  /**
   * A field that people leave empty and bots fill. A filled field gets a success answer and is not stored.
   * Default `website`. `false` turns it off.
   */
  honeypot?: string | false
  /** Largest body in bytes. Default 64 KB. */
  maxBytes?: number
  /** Other origins that may post, such as `https://example.com`. The app's own origin may always post. */
  origins?: readonly string[]
  /** Keep submissions in the Database, for the Console inbox. Default `true`. */
  store?: boolean
  notify?: FormNotify<StandardSchemaV1.InferOutput<TSchema>>
  /**
   * Runs after validation and before the submission is stored. Return a Response to answer with it and store nothing,
   * for example a 404 when the reported page does not exist.
   */
  onSubmit?: (submission: FormSubmission<StandardSchemaV1.InferOutput<TSchema>>, context: FormSubmitContext) => void | Response | Promise<void | Response>
}

/** A form that `defineForm()` checked. */
export interface FormDefinition<TSchema extends StandardSchemaV1 = StandardSchemaV1> {
  readonly "~form": true
  readonly options: Readonly<DefineFormOptions<TSchema>>
}

/** One validation problem. `path` is empty for a problem of the whole form. */
export interface FormIssue {
  message: string
  path: (string | number)[]
}

/** The rate limit decision for one request. */
export interface FormRateLimitDecision {
  allowed: boolean
  /** Seconds until the sender may try again. */
  retryAfter?: number
}

export interface FormEmailMessage {
  to: string | readonly string[]
  from?: string
  replyTo?: string
  subject: string
  text: string
}

/** What a submission reads, writes, and sends. A framework integration passes them; tests pass fakes. */
export interface FormServices {
  store?: FormsStore
  identify?: (request: Request) => FormUser | null | Promise<FormUser | null>
  rateLimit?: (request: Request, key: string, policy: FormRateLimit) => Promise<FormRateLimitDecision>
  email?: (message: FormEmailMessage) => Promise<void>
  /** Keeps background work, such as a notification, alive after the response. */
  waitUntil?: (promise: Promise<unknown>) => void
  /** Reports a failure that does not change the response, such as a notification that did not send. */
  log?: (message: string, error: unknown) => void
  now?: () => number
  id?: () => string
}

export interface ListFormSubmissionsOptions {
  form?: string
  status?: FormStatus
  /** Default 100, at most 500. */
  limit?: number
  /** Where the next page starts: the `createdAt` and `id` of the last submission of the page before. */
  before?: { createdAt: number, id: string }
}

/** Where submissions live. */
export interface FormsStore {
  insert(submission: FormSubmission): Promise<void>
  list(options?: ListFormSubmissionsOptions): Promise<FormSubmission[]>
  get(id: string): Promise<FormSubmission | undefined>
  setStatus(id: string, status: FormStatus, now: number): Promise<FormSubmission | undefined>
}
