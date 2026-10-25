import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { EmailPreview } from "./preview.ts"
import type { EmailOutboxList, EmailOutboxMessage } from "./runtime/console.ts"

// The runtime module reads the outbox of the app, which only exists in the Nitro runtime. The operations load it when
// they run, so the CLI and `vitehub inspect` can list them without it.
const runtime = () => import("./runtime/operations.ts")

function defineEmailOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  // The outbox answers for the section. The operations never read the signed-in user.
  return defineOperation({ ...definition, section: "email", user: false })
}

const outboxList = defineEmailOperation<Record<string, never>, EmailOutboxList>({
  cli: { command: "outbox-list" },
  description: "List the messages that the development outbox captured, newest first.",
  input: v.object({}),
  kind: "read",
  name: "email.outbox-list",
  run: async () => (await runtime()).listEmailOutboxMessages(),
})

const outboxShow = defineEmailOperation<{ id: string }, { message: EmailOutboxMessage }>({
  cli: { command: "outbox-show", positional: ["id"] },
  description: "Show one captured message with its bodies, headers, and attachment details.",
  input: v.object({ id: v.pipe(v.string(), v.minLength(1)) }),
  kind: "read",
  name: "email.outbox-show",
  run: async input => (await runtime()).showEmailOutboxMessage(input.id),
})

const outboxClear = defineEmailOperation<Record<string, never>, { cleared: number }>({
  cli: { command: "outbox-clear" },
  description: "Remove every message from the development outbox.",
  input: v.object({}),
  kind: "destructive",
  name: "email.outbox-clear",
  run: async () => (await runtime()).clearEmailOutboxMessages(),
})

const preview = defineEmailOperation<{ data?: Record<string, unknown>, template: string }, EmailPreview>({
  cli: { positional: ["template"] },
  description: "Render an Email template from server/emails without sending it.",
  input: v.object({
    data: v.optional(v.record(v.string(), v.unknown())),
    template: v.pipe(v.string(), v.minLength(1)),
  }),
  kind: "read",
  name: "email.preview",
  run: async input => await (await runtime()).previewEmail(input.template, input.data),
})

/** The `email.*` operations: the development outbox and template previews. The Console, `vitehub email`, and agents run them. */
export const emailOperations: readonly AnyOperation[] = [outboxList, outboxShow, outboxClear, preview]

export type { EmailOutboxList, EmailOutboxMessage, EmailPreview }
