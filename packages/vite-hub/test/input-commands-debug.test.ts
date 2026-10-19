import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { agentInvocationId, runAgent } from "@vite-hub/agent"
import { defineChannel } from "@vite-hub/agent/channels"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/agent.ts"
import { inputCommands } from "../src/agent/capabilities.ts"
import { installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import { console as consoleRuntime } from "../src/console/server.ts"

import type { AgentRuntimeContext } from "@vite-hub/agent"

const channelDeliveryHandlers = Symbol.for("vitehub.agent.channelDeliveryHandlers")

afterEach(() => {
  vi.restoreAllMocks()
})

describe("inputCommands({ debug })", () => {
  it("adds /debug without other commands and lets a debug command replace it", () => {
    expect(inputCommands({ debug: true }).metadata).toMatchObject({
      commands: { debug: { description: "Link the previous invocation in the ViteHub Console." } },
    })
    expect(inputCommands({ commands: { debug: { description: "Custom debug." } }, debug: true }).metadata).toEqual({
      commands: { debug: { description: "Custom debug." } },
      trigger: "/",
    })
    expect(inputCommands({ commands: { docs: {} }, debug: false }).metadata).toEqual({ commands: { docs: {} }, trigger: "/" })
    expect(() => inputCommands({ debug: false })).toThrow("inputCommands({ commands }) requires a command map")
    // SAFETY: The test sends an invalid value through the public runtime boundary.
    expect(() => inputCommands({ debug: "yes" as never })).toThrow("inputCommands({ debug }) must be true or false")
  })

  it("replies with the previous invocation of the same Agent and thread", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-debug-command-"))
    try {
      installConsoleInvocations(projectRoot)
      const replies: unknown[] = []
      const chat = defineChannel("chat", {
        [channelDeliveryHandlers]: {
          reply(context: { effect: { payload: unknown } }) {
            replies.push(context.effect.payload)
          },
        },
        messages: false,
      } as never)
      const driver = vi.fn(() => "done")
      const agent = defineAgent({
        capabilities: [inputCommands({ debug: true })],
        channels: { chat },
        driver: { run: driver },
        runtime: false,
      })
      const run = (runId: string, prompt: string, options: { agentName?: string, console?: boolean, threadId?: string } = {}) => {
        const context: AgentRuntimeContext = {
          agentIdentity: { name: options.agentName ?? "support" },
          capabilities: options.console === false ? {} : { console: consoleRuntime },
          memo: vi.fn(),
          request: new Request("https://chat.example/api/chat"),
          run: { channelId: "chat", runId, ...(options.threadId ? { threadId: options.threadId } : {}) },
          runtime: "unknown",
          waitUntil: vi.fn(),
        }
        return runAgent(agent, context, { prompt })
      }
      const link = async (runId: string) =>
        `https://chat.example/_vitehub/agents/support/invocations/${encodeURIComponent(await agentInvocationId(runId, "support"))}`

      await run("thread-one", "hello", { threadId: "t1" })
      await run("thread-two", "hello", { threadId: "t2" })
      await run("other-agent", "hello", { agentName: "other", threadId: "t1" })
      expect(driver).toHaveBeenCalledTimes(3)

      await run("debug-thread-one", "/debug", { threadId: "t1" })
      await run("debug-agent", "/debug")
      await run("debug-new-thread", "/debug", { threadId: "t3" })
      await run("debug-without-console", "/debug", { console: false, threadId: "t1" })

      expect(driver).toHaveBeenCalledTimes(3)
      expect(replies).toEqual([
        await link("thread-one"),
        await link("debug-thread-one"),
        "No previous invocation was found in the ViteHub Console.",
        "The ViteHub Console is not enabled for this Agent.",
      ])
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })
})
