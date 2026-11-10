import { afterEach, expect, it, vi } from "vitest"

import { requestConsole } from "../src/console/runtime/client/request.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"
import "./support/console-access.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Send the Console client's calls to one RPC handler instance. */
function serveWith(handler: typeof consoleRpcHandler): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(input, "http://vitehub.local"), init)
    expect(request.headers.get(consoleRpcHeader)).toBe("1")
    return handler.fetch(request)
  })
}

// This file resets the module registry. A module that a call imports after the reset comes from the new registry, so
// each handler instance serves its calls before the next reset, as a Worker isolate does with its own modules.
it("serves consecutive calls from different handler instances", async () => {
  installConsoleSections("/console-rpc-test", ["agents", "usage"])
  installConsoleProjectName("/console-rpc-test", "Stateless Console")
  serveWith(consoleRpcHandler)
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(requestConsole("/_vitehub/api/sections"))
      .resolves.toEqual({ projectName: "Stateless Console", sections: ["agents", "usage"] })
  }

  vi.resetModules()
  // A fresh module graph has no state from the first handler, like a second Worker isolate.
  const { default: secondHandler } = await import("../src/console/runtime/server/rpc.ts")
  expect(secondHandler).not.toBe(consoleRpcHandler)
  serveWith(secondHandler)
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(requestConsole("/_vitehub/api/sections"))
      .resolves.toEqual({ projectName: "Stateless Console", sections: ["agents", "usage"] })
  }
  await expect(requestConsole("/_vitehub/api/definitions"))
    .rejects.toMatchObject({ code: "INTERNAL_R0022", message: expect.stringContaining("section"), name: "ConsoleRequestError", status: 400 })
})
