import { defineAgent, defineCapability, type AgentInvoker } from "vite-hub/agent"
import { createLibsqlAgentState } from "vite-hub/agent/state"

const audit = defineCapability({
  id: "audit",
  prepare({ invoker: actor, context }) {
    context.set("audit.caller", actor.id, { overwrite: true })
  },
})

export function label(actor: AgentInvoker): string {
  return actor.label ?? actor.id
}

export const state = createLibsqlAgentState({ url: "file:.data/state.db" })

export default defineAgent({
  capabilities: [audit],
  hooks: {
    "agent:finish"(event) {
      console.info("finished for", event.invoker.id)
    },
  },
  driver: {
    run: ({ context }) => `Hello ${context.get("invoker")?.id}`,
  },
})
