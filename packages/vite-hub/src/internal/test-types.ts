import type { SerializedResponse } from "@vite-hub/runtime"

// The test facade must work without optional Primitives installed. These structural
// shapes keep their declarations local; test/test-api.test-d.ts checks compatibility.
export interface DeliverChannelOptions {
  /** The Agent name in the webhook URL and in each run. Defaults to `agent`. */
  agentName?: string
  /** Request headers, such as the signature or secret header that the Channel checks. */
  headers?: ConstructorParameters<typeof Headers>[0]
}

type EmailAddress = string | { email: string, name?: string }
type EmailAddressList = EmailAddress | readonly EmailAddress[]

type EmailBody =
  | { text: string, html?: string }
  | { html: string, text?: string }

export type TestEmailMessage = EmailBody & {
  from: EmailAddress
  to: EmailAddressList
  cc?: EmailAddressList
  bcc?: EmailAddressList
  replyTo?: EmailAddressList
  subject: string
  headers?: Record<string, string>
  attachments?: readonly {
    filename: string
    content: string | Uint8Array
    contentType?: string
    disposition?: "attachment" | "inline"
    cid?: string
  }[]
  tags?: readonly { name: string, value: string }[]
  idempotencyKey?: string
  scheduledAt?: string | Date
  unsubscribe?: { url?: string, mailto?: string, oneClick?: boolean }
  metadata?: Record<string, string>
}

export interface TestScheduleContext {
  id: string
  attemptId?: string
  payload?: unknown
  idempotencyKey: string
  runId?: string
  scheduleId?: string
  scheduledAt: Date
  target?: string
  waitUntil(promise: PromiseLike<unknown>): void
}

export interface TestScheduleDefinition {
  cron?: string
  handler(context: TestScheduleContext): unknown
  timeZone?: string
  options?: { manual?: boolean }
}

export interface TestScheduleRunRecord {
  attemptCount: number
  completedAt?: Date
  createdAt: Date
  error?: { message: string, name?: string, stack?: string }
  id: string
  scheduleId: string
  response?: SerializedResponse
  scheduledAt: Date
  startedAt?: Date
  status: "pending" | "running" | "succeeded" | "failed"
  target: string
  updatedAt: Date
}
