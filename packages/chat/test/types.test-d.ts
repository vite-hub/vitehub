import { describe, expectTypeOf, it } from "vitest"
import type { NitroRuntimeConfig } from "nitro/types"

import "../src/nitro.ts"
import { defineAgent } from "@vitehub/agent"
import { defineChat, type ChatModuleOptions } from "@vitehub/chat"
import {
  defineCloudflareChatHandler,
  type CloudflareExportedHandlerFetchHandler,
} from "@vitehub/chat/cloudflare"

declare module "nitro/types" {
  interface NitroRuntimeConfig {
    telegram: {
      apiBaseUrl: string | undefined
      botToken: string
    }
  }
}

declare module "@vitehub/agent" {
  interface AgentRuntimeConfig {
    telegram: {
      apiBaseUrl: string | undefined
      botToken: string
    }
  }
}

describe("Nitro runtime config types", () => {
  it("publishes self-contained cloudflare subpath types", () => {
    expectTypeOf(defineCloudflareChatHandler({} as never)).toMatchTypeOf<CloudflareExportedHandlerFetchHandler<Record<string, unknown>>>()
  })

  it("types defineChat runtimeConfig from Nitro runtime config", () => {
    expectTypeOf<NitroRuntimeConfig["telegram"]["botToken"]>().toEqualTypeOf<string>()

    defineChat({
      adapters({ runtimeConfig }) {
        expectTypeOf(runtimeConfig.telegram.apiBaseUrl).toEqualTypeOf<string | undefined>()
        expectTypeOf(runtimeConfig.telegram.botToken).toEqualTypeOf<string>()
        return {}
      },
      state: {} as never,
    })
  })

  it("types chat agent bindings and hooks", () => {
    defineChat({
      adapters: {},
      agent: "triager",
      state: {} as never,
    })

    defineChat({
      adapters: {},
      agent: {
        execution: "workflow",
        hooks: {
          prepareInput({ history, message, runtimeConfig, thread }) {
            expectTypeOf(history).toMatchTypeOf<Array<{ role: string }>>()
            expectTypeOf(message.text).toEqualTypeOf<string>()
            expectTypeOf(runtimeConfig.telegram.botToken).toEqualTypeOf<string>()
            expectTypeOf(thread.id).toEqualTypeOf<string>()
            return { messages: history }
          },
        },
        name: "triager",
      },
      fallbackStreamingPlaceholderText: ({ runtimeConfig }) => runtimeConfig.telegram.botToken ? "Thinking..." : null,
      state: {} as never,
    })
  })

  it("types agent-centered chat hooks", () => {
    defineAgent({
      chat: {
        adapters({ runtimeConfig }) {
          expectTypeOf(runtimeConfig.telegram.botToken).toEqualTypeOf<string>()
          return {}
        },
        execution: "workflow",
        fallbackStreamingPlaceholderText: ({ runtimeConfig }) => runtimeConfig.telegram.botToken ? "Thinking..." : null,
        history: { source: "thread", maxMessages: 20 },
        hooks: {
          onDirectMessage({ message }) {
            expectTypeOf(message.text).toEqualTypeOf<string>()
          },
        },
        state: {} as never,
      },
      hooks: {
        prepareInput({ runtimeConfig }) {
          expectTypeOf(runtimeConfig.telegram.botToken).toEqualTypeOf<string>()
        },
      },
      run: () => "ok",
    })

    defineAgent({
      chat: {
        // @ts-expect-error chat.agent is not part of defineAgent({ chat }) metadata
        agent: { name: "triager" },
        adapters: {},
        state: {} as never,
      },
      run: () => "ok",
    })
  })

  it("accepts dev initialization options", () => {
    expectTypeOf<ChatModuleOptions["dev"]>().toEqualTypeOf<false | { devtools?: boolean | { url?: string }, initialize?: boolean, localStateFallback?: boolean } | undefined>()
  })
})
