import { createRpcClient } from "devframe/rpc/client"
import { createSseRpcChannel } from "devframe/rpc/transports/sse-client"
import { describe, expect, it } from "vitest"

import { createConsoleDevframeHandler } from "../src/console/runtime/server/devframe.ts"
import {
  installConsoleProjectName,
  installConsoleSections,
} from "../src/console/runtime/server/sections.ts"

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

interface ConsoleRpcRequest {
  method: "GET" | "POST"
  path: string
  query: Record<string, string | string[]>
}

type ConsoleRpcResult =
  | { ok: true; value: unknown }
  | { message: string; ok: false; status: number }

describe("Console Devframe", () => {
  it("carries Console reads over an SSE-only RPC instance and closes cleanly", async () => {
    installConsoleSections("/console-devframe-test", ["agents", "usage"])
    installConsoleProjectName("/console-devframe-test", "SSE Console")
    const devframe = await createConsoleDevframeHandler()
    const fetchThroughNitroHandler: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      return await devframe.handler({
        method: request.method,
        req: request,
      } as unknown as ConsoleRequestEvent)
    }
    const channel = createSseRpcChannel({
      fetch: fetchThroughNitroHandler,
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<Record<string, never>, Record<string, never>>({}, { channel })

    try {
      await devframe.instance.ready
      expect(devframe.instance.connectionMeta()).toMatchObject({
        backend: "sse",
        sse: { path: "__sse" },
      })
      const result = await (
        client as unknown as {
          $call(name: string, input: ConsoleRpcRequest): Promise<ConsoleRpcResult>
        }
      ).$call("vitehub:console:request", {
        method: "GET",
        path: "/api/_vitehub/console/sections",
        query: {},
      })

      expect(result).toEqual({
        ok: true,
        value: { projectName: "SSE Console", sections: ["agents", "usage"] },
      })
    } finally {
      channel.close()
      await devframe.close()
    }
  })

  it("returns protocol errors through the same RPC method", async () => {
    const devframe = await createConsoleDevframeHandler()
    const channel = createSseRpcChannel({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        return await devframe.handler({
          method: request.method,
          req: request,
        } as unknown as ConsoleRequestEvent)
      },
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<Record<string, never>, Record<string, never>>({}, { channel })

    try {
      const result = await (
        client as unknown as {
          $call(name: string, input: ConsoleRpcRequest): Promise<ConsoleRpcResult>
        }
      ).$call("vitehub:console:request", {
        method: "GET",
        path: "/api/_vitehub/console/unknown",
        query: {},
      })

      expect(result).toEqual({ message: "Console operation not found.", ok: false, status: 404 })
    } finally {
      channel.close()
      await devframe.close()
    }
  })
})
