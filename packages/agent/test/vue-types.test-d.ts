import { asUnknownBoundary } from "../src/internal/runtime-type.ts"
import { describe, expectTypeOf, it } from "vitest"

import {
  useAgent,
  useAgentInvocation,
  useAgentInvocations,
  useChat,
  type AgentChatInit,
  type AgentChatReactiveInit,
  type AgentClient,
  type AgentInvocationRequester,
} from "../src/vue.ts"

import type { TraceEventLogEntry } from "@vite-hub/runtime"
import type { ChatTransport, UIMessage } from "ai"
import type { ComputedRef, MaybeRefOrGetter, ShallowRef } from "vue"
import type { AgentInvocationSummary } from "../src/invocations.ts"

describe("Agent Vue client types", () => {
  it("preserves AI SDK Vue message and transport types", () => {
    const agent = useAgent("support")
    expectTypeOf(agent).toEqualTypeOf<AgentClient>()
    expectTypeOf(agent.name).toEqualTypeOf<string>()

    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const transport = {} as ChatTransport<UIMessage>
    const init = { api: "/api/support", transport } satisfies AgentChatInit
    const chat = useChat(agent, init)

    expectTypeOf(chat.id).toEqualTypeOf<ComputedRef<string>>()
    expectTypeOf(chat.messages).toEqualTypeOf<ShallowRef<UIMessage[]>>()
    expectTypeOf(chat.data).toEqualTypeOf<ComputedRef<import("../src/messages.ts").AgentChatData>>()
    expectTypeOf(chat.status.value).toEqualTypeOf<"submitted" | "streaming" | "ready" | "error">()
    expectTypeOf(chat.sendMessage).toBeFunction()
    expectTypeOf(useChat).toBeCallableWith(agent, (() => init) satisfies MaybeRefOrGetter<AgentChatReactiveInit>)

    // @ts-expect-error AI SDK constructor-only options cannot update without resetting an active chat.
    useChat(agent, () => ({ generateId: () => "message-id" }))

    const staticInit: AgentChatInit = { generateId: () => "message-id", id: "support" }
    useChat(agent, staticInit)
    // @ts-expect-error Pretyped constructor-only options are also excluded from reactive getters.
    useChat(agent, () => staticInit)
  })

  it("exposes typed invocation list and detail resources", () => {
    // SAFETY: This compile-time fixture intentionally supplies the exact asserted public contract.
    const request = asUnknownBoundary(null) as AgentInvocationRequester
    const list = useAgentInvocations({ immediate: false, request })
    const detail = useAgentInvocation("inv-1", { immediate: false, request })

    expectTypeOf(list.invocations).toEqualTypeOf<ShallowRef<readonly AgentInvocationSummary[]>>()
    expectTypeOf(list.cursor).toEqualTypeOf<ShallowRef<string | undefined>>()
    expectTypeOf(list.refresh).toBeFunction()
    expectTypeOf(list.loadMore).toBeFunction()
    expectTypeOf(list.isLoadingMore).toEqualTypeOf<ShallowRef<boolean>>()
    expectTypeOf(list.loadMoreError).toEqualTypeOf<ShallowRef<unknown>>()
    expectTypeOf(list.stop).toBeFunction()
    expectTypeOf(detail.invocation).toEqualTypeOf<ShallowRef<AgentInvocationSummary | null>>()
    expectTypeOf(detail.observations).toEqualTypeOf<ShallowRef<readonly TraceEventLogEntry[]>>()
    expectTypeOf(detail.refresh).toBeFunction()
    expectTypeOf(detail.stop).toBeFunction()

    useAgentInvocations({ pollInterval: 100, request })
    useAgentInvocation("inv-1", { pollInterval: 100, request })
    // @ts-expect-error Applications must own the requester used to load Agent Invocations.
    useAgentInvocations()
    // @ts-expect-error Applications must own the requester used to load Agent Invocation details.
    useAgentInvocation("inv-1")
  })
})
