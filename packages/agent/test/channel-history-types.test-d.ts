import { describe, expectTypeOf, it } from "vitest"
import * as v from "valibot"
import type { AgentChannelMessageContext } from "@vite-hub/agent"
import { defineCollection } from "@vite-hub/source"
import { defineChannel, discord, github, http, slack, teams, telegram, webChat } from "@vite-hub/agent/channels"

interface HistoryItem {
  id: string
  subject: string
}

const collection = defineCollection(async () => [{ id: "m1", subject: "Invoice" }], {
  cursor: (item: HistoryItem) => item.id,
  cursorSchema: v.string(),
})

describe("built-in Channel replay public types", () => {
  it("preserves existing explicit defineChannel generic positions", () => {
    interface RuntimeConfig { mailbox: { token: string } }
    interface Data { id: string }
    type Methods = { label: (context: AgentChannelMessageContext<RuntimeConfig, Data>, name: string) => string }
    const channel = defineChannel<"mailbox", Methods, RuntimeConfig, Data>("mailbox", {
      message: { data: v.object({ id: v.string() }), methods: { label(context, name) {
        expectTypeOf(context.message).toEqualTypeOf<Data>()
        expectTypeOf(context).toEqualTypeOf<AgentChannelMessageContext<RuntimeConfig, Data>>()
        return name
      } } },
    })
    expectTypeOf(channel.kind).toEqualTypeOf<"mailbox">()
    defineChannel<"mailbox", Record<never, never>>("mailbox")
    defineChannel<"mailbox", Methods, RuntimeConfig, Data, HistoryItem>("mailbox", {
      history: { collection, key: item => item.id },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers discord replay items independently of message data", () => {
    discord({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    discord({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers github replay items independently of message data", () => {
    github({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    github({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers http replay items independently of message data", () => {
    http({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    http({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers slack replay items independently of message data", () => {
    slack({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    slack({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers teams replay items independently of message data", () => {
    teams({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    teams({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers telegram replay items independently of message data", () => {
    telegram({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    telegram({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("infers webChat replay items independently of message data", () => {
    webChat({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    webChat({
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } },
      message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })

  it("accepts history with GitHub pull-request workspace overloads", () => {
    github({ pullRequest: true, history: { collection, trigger: "received", key: item => item.id },
      triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
    github({ pullRequest: true, message: { data: v.object({ messageOnly: v.string() }), methods: { label(context, name: string) {
        expectTypeOf(context.message).toEqualTypeOf<{ messageOnly: string }>()
        return name
      } } },
      history: { collection, trigger: "received", key(item) {
        expectTypeOf(item).toEqualTypeOf<HistoryItem>()
        return item.id
      } }, triggers: { received: { invoke: () => ({ input: { prompt: "Replay" } }) } },
    })
  })
})
