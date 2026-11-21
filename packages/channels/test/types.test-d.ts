import { describe, it } from "vitest"

import { stripe, webhook } from "../src/adapters.ts"
import type { StripeEvent } from "../src/adapters.ts"
import { createChannel, defineChannel, useChannel } from "../src/index.ts"
import type { ChannelMessage, ChannelSendOptions } from "../src/index.ts"

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
    // @ts-expect-error A text adapter takes only text.
    optional.send({ card: {} })

    type Card = { card: { title: string }, fallbackText: string }
    const cardAdapter = { kind: "teams", send: (_message: string | Card, _options: { recipient: string }) => ({}) }
    const cards = createChannel("cards", defineChannel({ adapter: cardAdapter }))
    cards.send("Build finished.", { recipient: "general" })
    cards.send({ card: { title: "Build" }, fallbackText: "Build finished." }, { recipient: "general" })
    // @ts-expect-error The adapter's message type rejects other objects.
    cards.send({ adaptiveCard: {} }, { recipient: "general" })
    const message: ChannelMessage<typeof cardAdapter> = { card: { title: "Build" }, fallbackText: "Build finished." }
    void message

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
    // @ts-expect-error Discovered Channels keep their adapter's message type.
    useChannel("alerts").send({ card: {} }, { chatId: "chat-1" })
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
      adapter: webhook<{ flow_run_id: string }>({ signature: "bearer", secret: "PREFECT_WEBHOOK_SECRET" }),
      on: {
        webhook: (event) => {
          const id: string = event.data.flow_run_id
          return id
        },
        record: { invoke: () => new Response(null) },
      },
    })

    defineChannel({
      adapter: webhook({ secret: false }),
      on: {
        // @ts-expect-error A target is a handler or a trigger.
        webhook: { run: () => undefined },
      },
    })

    // @ts-expect-error A Channel needs an adapter.
    defineChannel({ on: {} })
  })

  it("requires webhook verification or an explicit opt-out", () => {
    webhook({ signature: "bearer", secret: () => process.env.TOKEN })
    webhook({ signature: "token", header: "x-gitlab-token", secret: "GITLAB_WEBHOOK_TOKEN" })
    webhook({ signature: "github", secret: "GITHUB_WEBHOOK_SECRET" })
    webhook({ signature: { type: "stripe", tolerance: "10m" }, secret: "STRIPE_WEBHOOK_SECRET" })
    // @ts-expect-error The signature names follow Webhooks: `"github"`.
    webhook({ signature: "github-sha256", secret: "GITHUB_WEBHOOK_SECRET" })
    // @ts-expect-error `tolerance` is a duration string.
    webhook({ signature: { type: "stripe", tolerance: 300 }, secret: "STRIPE_WEBHOOK_SECRET" })
    webhook({ secret: false })
    // @ts-expect-error `webhook()` needs `signature` and `secret`, or `secret: false`.
    webhook()
    // @ts-expect-error A webhook without verification needs `secret: false`.
    webhook({})
    // @ts-expect-error A `secret` needs a `signature`.
    webhook({ secret: "HOOK_SECRET" })
    // @ts-expect-error A `signature` needs a `secret`.
    webhook({ signature: "bearer" })
    // @ts-expect-error `secret: false` turns verification off, so it takes no `signature`.
    webhook({ signature: "bearer", secret: false })
    // @ts-expect-error `signature: 'token'` needs a `header`.
    webhook({ signature: "token", secret: "HOOK_SECRET" })
    // @ts-expect-error `stripe()` always verifies.
    stripe({ secret: false })
  })
})
