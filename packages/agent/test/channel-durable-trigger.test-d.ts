import { describe, expectTypeOf, it } from "vitest"
import { defineChannel, defineChannelTrigger, type AgentChannelStateBinding, type AgentDurableChannelTriggerContext } from "../src/channels.ts"

describe("Channel trigger durableState", () => {
  it("types channelState as present with durableState: true", () => {
    const trigger = defineChannelTrigger({
      durableState: true,
      invoke: (context) => {
        expectTypeOf(context).toEqualTypeOf<AgentDurableChannelTriggerContext>()
        expectTypeOf(context.channelState).toEqualTypeOf<AgentChannelStateBinding>()
        return { input: { prompt: context.channelState.keyPrefix } }
      },
    })
    defineChannel("tickets", { messages: false, triggers: { opened: trigger } })
  })

  it("keeps channelState optional without durableState", () => {
    for (const durableState of [undefined, false] as const) {
      const trigger = defineChannelTrigger({
        durableState,
        invoke: (context) => {
          expectTypeOf(context.channelState).toEqualTypeOf<AgentChannelStateBinding | undefined>()
          return { input: { prompt: "triage" } }
        },
      })
      defineChannel("tickets", { messages: false, triggers: { opened: trigger } })
    }
  })

  it("types inline Channel triggers by durableState", () => {
    defineChannel("tickets", {
      messages: false,
      triggers: {
        durable: {
          durableState: true,
          invoke: (context) => {
            expectTypeOf(context.channelState).toEqualTypeOf<AgentChannelStateBinding>()
            return { input: { prompt: "triage" } }
          },
        },
        plain: {
          invoke: (context) => {
            expectTypeOf(context.channelState).toEqualTypeOf<AgentChannelStateBinding | undefined>()
            return { input: { prompt: "triage" } }
          },
        },
      },
    })
  })
})
