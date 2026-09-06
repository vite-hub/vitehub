import { expectTypeOf } from "vitest"
import { createMessage } from "../src/messages.ts"

import type { CreateMessageOptions, Message } from "../src/messages.ts"

expectTypeOf(createMessage({ role: "user", text: "Question" }).role).toEqualTypeOf<"user">()
expectTypeOf(createMessage({ role: "assistant", text: "Answer" }).role).toEqualTypeOf<"assistant">()

declare const options: CreateMessageOptions
expectTypeOf(createMessage(options).role).toEqualTypeOf<Message["role"]>()

const history: Array<Message & { role: "user" | "assistant" }> = [
  createMessage({ role: "user", text: "Question" }),
  createMessage({ role: "assistant", text: "Answer" }),
]
// @ts-expect-error A system message cannot enter user/assistant history.
history.push(createMessage({ role: "system", text: "Instruction" }))
