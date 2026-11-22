import { afterEach, expect, it, vi } from "vitest"

import { runDiscordGatewayListeners } from "../src/server/internal.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

it("does not run a listener again after it answers 204", async () => {
  const listen = vi.fn(async () => new Response(null, { status: 204 }))
  const stop = runDiscordGatewayListeners({ support: listen }, 10)
  await new Promise(resolve => setTimeout(resolve, 50))
  await stop()
  expect(listen).toHaveBeenCalledTimes(1)
})

it("runs a listener again when its Gateway connection closes", async () => {
  const listen = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return new Response(null, { status: 200 })
  })
  const stop = runDiscordGatewayListeners({ support: listen }, 60_000)
  await vi.waitFor(() => expect(listen.mock.calls.length).toBeGreaterThanOrEqual(3))
  await stop()
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
