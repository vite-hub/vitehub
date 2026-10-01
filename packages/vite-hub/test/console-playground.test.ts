import { afterEach, expect, it, vi } from "vitest"

import { requestConsole } from "../src/console/runtime/client/request.ts"

// The playground is outside this package's TypeScript project, so load its real module at test time.
const { callConsoleFixture } = await vi.importActual<{
  callConsoleFixture: (origin: string, payload: unknown) => Promise<unknown>
}>("../../../playground/console/rpc.ts")

afterEach(() => {
  vi.unstubAllGlobals()
})

it("loads Console data through the playground's stateless RPC endpoint", async () => {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/_vitehub/rpc/__call") {
      return Response.json(await callConsoleFixture("http://localhost:5173", JSON.parse(String(init?.body))))
    }
    return Response.json({ sections: ["agents"] })
  })
  vi.stubGlobal("fetch", fetch)

  await expect(requestConsole("/api/_vitehub/console/sections"))
    .resolves.toEqual({ sections: ["agents"] })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenLastCalledWith(new URL("http://localhost:5173/api/_vitehub/console/sections"), {
    body: undefined,
    headers: { "content-type": "application/json" },
    method: "GET",
  })
})
