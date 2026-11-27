import { describe, expectTypeOf, it } from "vitest"
import { Card, CardText } from "chat"
import { createChannel, defineChannel } from "@vite-hub/channels"
import type { ChannelMessage } from "@vite-hub/channels"
import { channelDelivery } from "../src/capabilities/index.ts"
import type { ChannelDeliveryOptions } from "../src/capabilities/index.ts"
import { slack, teams } from "../src/channels.ts"
import type { ChatMessage, ChatSendOptions, TeamsChatMessage } from "../src/channels.ts"

const adapter = teams()
const channel = createChannel("teams", defineChannel({ adapter }))
const card = Card({ title: "Build 7", children: [CardText("Failed on main.")] })

describe("chat Channel messages", () => {
  it("sends Markdown text or a Chat SDK message", () => {
    expectTypeOf<ChannelMessage<typeof adapter>>().toEqualTypeOf<TeamsChatMessage>()
    channel.send("**Build 7 failed**", { recipient: "teams:general" })
    channel.send({ card, fallbackText: "Build 7 failed" }, { recipient: "teams:general" })
    channel.send(card, { recipient: "teams:general", thread: { key: "build:7", root: { card } } })
    // @ts-expect-error A chat message is text or a Chat SDK message.
    channel.send({ text: "Build 7 failed" }, { recipient: "teams:general" })
  })

  it("sends a raw Adaptive Card only to Teams", () => {
    const adaptiveCard = { type: "AdaptiveCard", version: "1.5", body: [{ type: "Badge", text: "Draft" }] }
    channel.send({ adaptiveCard, fallbackText: "Draft" }, { recipient: "teams:general" })
    const slackChannel = createChannel("slack", defineChannel({ adapter: slack() }))
    // @ts-expect-error Only the Teams adapter sends a raw Adaptive Card.
    slackChannel.send({ adaptiveCard, fallbackText: "Draft" }, { recipient: "slack:C1" })
  })

  it("lets channelDelivery() take a chat Channel and keep its message type", () => {
    channelDelivery({ channel, options: { recipient: "teams:general" } })
    const deliveryChannel: ChannelDeliveryOptions<ChatSendOptions, ChatMessage>["channel"] = channel
    deliveryChannel.send({ card, fallbackText: "Build 7 failed" }, { recipient: "teams:general" })
  })
})
