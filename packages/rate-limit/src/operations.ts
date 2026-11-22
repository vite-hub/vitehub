import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation, OperationDefinition } from "@vite-hub/internal/operations"
import type { RateLimitPeekInspection, RateLimitResetInspection } from "./counters.ts"

const runtime = () => import("./runtime/operations.ts")

const target = v.object({
  key: v.pipe(v.string(), v.minLength(1, "Name the limited key, for example a client IP or user ID.")),
  name: v.pipe(v.string(), v.check(name => name.trim() !== "", "Name the stable ID of `requireRateLimit()`.")),
})

function defineRateLimitOperation<Input, Output>(definition: Omit<OperationDefinition<Input, Output>, "section" | "user">): OperationDefinition<Input, Output> {
  return defineOperation({ ...definition, cli: { namespace: "rate-limit", ...definition.cli }, section: "rate-limits", user: false })
}

const peek = defineRateLimitOperation<{ key: string, name: string }, RateLimitPeekInspection>({
  cli: { positional: ["name", "key"] },
  description: "Show the counter of one key without consuming a token.",
  input: target,
  kind: "read",
  name: "rate-limit.peek",
  run: async input => await (await runtime()).peekRateLimitOperation(input.name, input.key),
})

const reset = defineRateLimitOperation<{ key: string, name: string }, RateLimitResetInspection>({
  cli: { positional: ["name", "key"] },
  description: "Delete the counter of one key, where the provider supports it.",
  input: target,
  kind: "destructive",
  name: "rate-limit.reset",
  run: async input => await (await runtime()).resetRateLimitOperation(input.name, input.key),
})

/** The `rate-limit.*` operations: peek and reset. The Console, `vitehub rate-limit`, and agents run them. */
export const rateLimitOperations: readonly AnyOperation[] = [peek, reset]

export type { RateLimitPeekInspection, RateLimitResetInspection }

export { createStandaloneOperationHandler } from "@vite-hub/internal/operations-dev"
