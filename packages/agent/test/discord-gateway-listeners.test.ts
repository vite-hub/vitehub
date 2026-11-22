import { afterEach, expect, it, vi } from "vitest"

import { runDiscordGatewayListeners } from "../src/server/discord-gateway-listeners.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

it("does not run a listener again when there is no Gateway", async () => {
  let runs = 0
  const listen = vi.fn(async () => {
    if (++runs === 2) void stop()
    return null
  })
  const stop = runDiscordGatewayListeners({ support: listen }, 10)
  await new Promise(resolve => setTimeout(resolve, 50))
  await stop()
  expect(listen).toHaveBeenCalledTimes(1)
})

it.each([200, 204])("runs a listener again when its Gateway connection closes with %i", async (status) => {
  let runs = 0
  const listen = vi.fn(async () => {
    if (++runs === 3) void stop()
    return new Response(null, { status })
  })
  const stop = runDiscordGatewayListeners({ support: listen }, 60_000)
  await new Promise(resolve => setImmediate(resolve))
  await stop()
  expect(listen).toHaveBeenCalledTimes(3)
})

it("logs a failed listener with a coded diagnostic and runs it again after the retry delay", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const listen = vi.fn(async () => new Response(null, { status: 500 }))
  const stop = runDiscordGatewayListeners({ support: listen }, 20)
  await vi.waitFor(() => expect(listen.mock.calls.length).toBeGreaterThanOrEqual(2))
  await stop()
  expect(error.mock.calls[0]?.[1]).toMatchObject({ code: "AGENT_R0896" })
})

it("stops a listener that waits to retry", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const listen = vi.fn(async () => {
    throw new Error("Discord is down")
  })
  const stop = runDiscordGatewayListeners({ support: listen }, 60_000)
  await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(1))
  await stop()
  expect(listen).toHaveBeenCalledTimes(1)
})
