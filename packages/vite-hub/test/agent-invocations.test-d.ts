import { expectTypeOf, it } from "vitest"
import * as v from "valibot"

import { defineAgent, runAgent } from "../src/agent.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import type { AgentInvocations } from "@vite-hub/agent"

it("accepts journal names and keeps Agent inference", () => {
  const agent = defineAgent({
    data: v.object({ id: v.string() }),
    driver: { run: () => ({ ok: true }) },
    invocations: "database",
  })
  expectTypeOf(agent.invocations).toEqualTypeOf<AgentInvocations | undefined>()
  expectTypeOf(runAgent(agent, { data: { id: "1" }, prompt: "Hello" })).resolves.toExtend<readonly [unknown, unknown]>()

  defineAgent({ driver: { run: () => "ok" }, invocations: "memory" })
  defineAgent({ driver: { run: () => "ok" }, invocations: false })
  defineAgent({ driver: { run: () => "ok" }, invocations: { content: "content", database: "journal", store: "database" } })
  defineAgent({ driver: { run: () => "ok" }, invocations: { store: createMemoryAgentInvocationStore() } })
  defineAgent({ driver: { run: () => "ok" }, invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }) })
  // @ts-expect-error Only the database and memory journal names exist.
  defineAgent({ driver: { run: () => "ok" }, invocations: "kv" })
  // @ts-expect-error `database` applies only to the Database store.
  defineAgent({ driver: { run: () => "ok" }, invocations: { database: "journal", store: createMemoryAgentInvocationStore() } })
})
