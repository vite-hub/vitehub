import { defineAgent, defineCapability, type AgentActor } from "vite-hub/agent"
import { createLibsqlAgentState } from "vite-hub/agent/state/sqlite"

const audit = defineCapability({
  id: "audit",
  prepare({ actor, context }) {
    context.set("audit.caller", actor.id, { overwrite: true })
  },
})

export function label(actor: AgentActor): string {
  return actor.label ?? actor.id
}

export const state = createLibsqlAgentState({ url: "file:.data/state.db" })

export default defineAgent({
  capabilities: [audit],
  hooks: {
    "agent:finish"(event) {
      console.info("finished for", event.actor.id)
    },
  },
  driver: {
    run: ({ context }) => `Hello ${context.get("actor")?.id}`,
  },
})
