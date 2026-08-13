import { describe, expectTypeOf, it } from "vitest"

import { useAgent, useChat, type AgentChatInit, type AgentClient } from "../src/vue.ts"

import type { ChatTransport, UIMessage } from "ai"
import type { ComputedRef, MaybeRefOrGetter, ShallowRef } from "vue"

describe("Agent Vue client types", () => {
  it("preserves AI SDK Vue message and transport types", () => {
    const agent = useAgent("support")
    expectTypeOf(agent).toEqualTypeOf<AgentClient>()
    expectTypeOf(agent.name).toEqualTypeOf<string>()

    const transport = {} as ChatTransport<UIMessage>
    const init = { api: "/api/support", transport } satisfies AgentChatInit
    const chat = useChat(agent, init)

    expectTypeOf(chat.id).toEqualTypeOf<ComputedRef<string>>()
    expectTypeOf(chat.messages).toEqualTypeOf<ShallowRef<UIMessage[]>>()
    expectTypeOf(chat.data).toEqualTypeOf<ComputedRef<import("../src/messages.ts").AgentChatData>>()
    expectTypeOf(chat.status.value).toEqualTypeOf<"submitted" | "streaming" | "ready" | "error">()
    expectTypeOf(chat.sendMessage).toBeFunction()
    expectTypeOf(useChat).toBeCallableWith(agent, (() => init) satisfies MaybeRefOrGetter<AgentChatInit>)
  })
})
