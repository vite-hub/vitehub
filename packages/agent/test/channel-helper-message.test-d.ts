import { describe, expectTypeOf, it } from "vitest"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { discord, github, http, slack, teams, telegram, webChat } from "../src/channels.ts"
import type { AgentChannelMessageOf, AgentRuntimeConfig } from "../src/types.ts"

const schema = {
  "~standard": {
    validate: (input: unknown) => ({ value: { id: String(input) } }),
    vendor: "test",
    version: 1,
  },
} satisfies StandardSchemaV1<unknown, { id: string }>

describe("built-in Channel message inference", () => {
  it("preserves discord message data and methods", () => {
    const channel = discord({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(discord<AgentRuntimeConfig>().kind).toEqualTypeOf<"discord">()
  })

  it("preserves github message data and methods", () => {
    const channel = github({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(github<AgentRuntimeConfig>().kind).toEqualTypeOf<"github">()
  })

  it("preserves http message data and methods", () => {
    const channel = http({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(http<AgentRuntimeConfig>().kind).toEqualTypeOf<"http">()
  })

  it("preserves slack message data and methods", () => {
    const channel = slack({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(slack<AgentRuntimeConfig>().kind).toEqualTypeOf<"slack">()
  })

  it("preserves teams message data and methods", () => {
    const channel = teams({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(teams<AgentRuntimeConfig>().kind).toEqualTypeOf<"teams">()
  })

  it("preserves telegram message data and methods", () => {
    const channel = telegram({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(telegram<AgentRuntimeConfig>().kind).toEqualTypeOf<"telegram">()
  })

  it("preserves webChat message data and methods", () => {
    const channel = webChat({
      message: {
        data: schema,
        methods: {
          label(context, value: string) {
            expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
            return context.message.id + value
          },
          subject: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    type Message = NonNullable<AgentChannelMessageOf<{ support: typeof channel }>>
    expectTypeOf<Message["data"]>().toEqualTypeOf<{ id: string }>()
    expectTypeOf<Message["label"]>().toEqualTypeOf<(value: string) => Promise<string | undefined>>()
    expectTypeOf<Message["subject"]>().toEqualTypeOf<() => Promise<string>>()
    expectTypeOf(webChat<AgentRuntimeConfig>().kind).toEqualTypeOf<"web-chat">()
  })

  it("retains GitHub workspace capabilities with message methods", () => {
    const channel = github({
      pullRequest: true,
      message: {
        data: schema,
        methods: {
          inspect: {
            read: true,
            handler(context) {
              expectTypeOf(context.message).toEqualTypeOf<{ id: string }>()
              return context.message.id
            },
          },
        },
      },
    })
    expectTypeOf(channel.capabilities[0].workspace).not.toBeUndefined()
    type Message = NonNullable<AgentChannelMessageOf<{ review: typeof channel }>>
    expectTypeOf<Message["inspect"]>().toEqualTypeOf<() => Promise<string>>()
  })
})
