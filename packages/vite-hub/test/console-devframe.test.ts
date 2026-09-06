import { createRpcClient } from "devframe/rpc/client"
import { createSseRpcChannel } from "devframe/rpc/transports/sse-client"
import { describe, expect, it } from "vitest"

import { createConsoleDevframeHandler } from "../src/console/runtime/server/devframe.ts"
import { consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"

import type { ConsoleRpcFunctions } from "../src/console/runtime/rpc.ts"

describe("Console Devframe", () => {
  it("carries Console reads over an SSE-only RPC instance and closes cleanly", async () => {
    installConsoleSections("/console-devframe-test", ["agents", "usage"])
    installConsoleProjectName("/console-devframe-test", "SSE Console")
    const handler = createConsoleDevframeHandler()
    const fetchThroughNitroHandler: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      return (await handler({
        method: request.method,
        req: request,
      } as never)) as Response
    }
    const channel = createSseRpcChannel({
      fetch: fetchThroughNitroHandler,
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<ConsoleRpcFunctions>({}, { channel })

    try {
      const connection = await fetchThroughNitroHandler("http://vitehub.local/_vitehub/rpc/__connection.json")
      await expect(connection.json()).resolves.toMatchObject({
        backend: "sse",
        sse: { path: "__sse" },
      })
      const result = await client.$call(consoleRpcMethods.sections, {})

      expect(result).toEqual({
        ok: true,
        value: { projectName: "SSE Console", sections: ["agents", "usage"] },
      })
    } finally {
      channel.close()
      await handler.close()
    }
  })

  it("returns operation errors through their RPC method", async () => {
    const handler = createConsoleDevframeHandler()
    const channel = createSseRpcChannel({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
        return (await handler({
          method: request.method,
          req: request,
        } as never)) as Response
      },
      url: "http://vitehub.local/_vitehub/rpc/__sse",
    })
    const client = createRpcClient<ConsoleRpcFunctions>({}, { channel })

    try {
      const result = await client.$call(consoleRpcMethods.definitions, {})

      expect(result).toEqual({
        message: "A valid definition section is required.",
        ok: false,
        status: 400,
      })
    } finally {
      channel.close()
      await handler.close()
    }
  })
})
