import { describe, it } from "vitest"

import { createChannel, defineChannel, stripe, useChannel, webhook } from "../src/index.ts"
import type { ChannelSendOptions, StripeEvent } from "../src/index.ts"

declare global {
  interface ViteHubChannelDefinitionModules {
    alerts: { default: typeof definition }
    payments: { default: typeof payments }
  }
}

const definition = defineChannel({
  adapter: {
    kind: "telegram",
    send: async (_text: string, options: { chatId: string, silent?: boolean }) => ({ id: options.chatId }),
  },
})

const payments = defineChannel({
  adapter: stripe({ stateScope: "webhook:support:stripe:stripe:" }),
  on: {
    "checkout.session.completed": (event) => {
      const stripeEvent: StripeEvent = event.data
      const id: string = event.id
      return { id, object: stripeEvent.data.object }
    },
  },
})

describe("Channel types", () => {
  it("types send options from the adapter", () => {
    const channel = createChannel("alerts", definition)
    channel.send("Build finished.", { chatId: "chat-1" })
    channel.send("Build finished.", { chatId: "chat-1", silent: true })
    // @ts-expect-error The adapter requires its options.
    channel.send("Build finished.")
    // @ts-expect-error The adapter options reject unknown properties.
    channel.send("Build finished.", { chatId: "chat-1", slient: true })

    const options: ChannelSendOptions<typeof definition.adapter> = { chatId: "chat-1" }
    void options

    const optional = createChannel("log", defineChannel({ adapter: { kind: "log", send: (_text: string) => ({}) } }))
    optional.send("Build finished.")

    async function checkSendTuple() {
      const [error, receipt] = await channel.send("Build finished.", { chatId: "chat-1" })
      if (error) {
        const code: "CHANNEL_DEFINITION_FAILED" | "CHANNEL_INVALID_SEND" | "CHANNEL_SEND_FAILED" = error.code
        const absent: undefined = receipt
        return { absent, code }
      }
      const noError: undefined = error
      const deliveryId: string = receipt.deliveryId
      return { noError, deliveryId }
    }
    void checkSendTuple
  })

  it("types discovered Channels by name", () => {
    useChannel("alerts").send("Build finished.", { chatId: "chat-1" })
    // @ts-expect-error Discovered Channels keep their adapter's options.
    useChannel("alerts").send("Build finished.", { channelId: "channel-1" })
    // @ts-expect-error Generated Channel names reject unknown literals.
    useChannel("alrets")

    const runtimeName: string = "runtime-channel"
    useChannel(runtimeName).send("Build finished.", { destination: "room-1" })
    useChannel(runtimeName).send("Build finished.")
  })

  it("types inbound targets from the adapter", () => {
    defineChannel({
      adapter: webhook<{ flow_run_id: string }>({ signature: "bearer", secret: "token" }),
      on: {
        webhook: (event) => {
          const id: string = event.data.flow_run_id
          return id
        },
        record: { invoke: () => new Response(null) },
      },
    })

    defineChannel({
      adapter: webhook(),
      on: {
        // @ts-expect-error A target is a handler or a trigger.
        webhook: { run: () => undefined },
      },
    })

    // @ts-expect-error A Channel needs an adapter.
    defineChannel({ on: {} })
  })
})
