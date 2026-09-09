import { afterEach, expect, it, vi } from "vitest"

// Match the playground's devframe/client alias with its real synthetic client.
vi.mock("devframe/client", () => vi.importActual("../../../playground/console/mock-rpc.ts"))

import { requestConsole } from "../src/console/runtime/client/request.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

it("loads Console data through the playground client after the trust handshake", async () => {
  vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } })
  const fetch = vi.fn().mockResolvedValue(Response.json({ sections: ["agents"] }))
  vi.stubGlobal("fetch", fetch)

  await expect(requestConsole("/api/_vitehub/console/sections"))
    .resolves.toEqual({ sections: ["agents"] })
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith(new URL("http://localhost:5173/api/_vitehub/console/sections"), {
    body: undefined,
    headers: { "content-type": "application/json" },
    method: "GET",
  })
})
