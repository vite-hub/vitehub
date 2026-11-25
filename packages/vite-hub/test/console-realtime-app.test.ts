import { afterEach, expect, it, vi } from "vitest"

import { consoleRealtimeAccess } from "../src/console/runtime/server/access.ts"
import { requestEvent } from "./console-event.ts"

vi.mock("#vitehub/console/app", async () => {
  const { installConsoleAccess } = await import("../src/console/runtime/server/access.ts")
  installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["content"] }) })
  return {}
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
})

it("loads the Console app module before the first Realtime room check", async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  const event = requestEvent(new Request("http://vitehub.local/_vitehub/realtime"))
  await expect(consoleRealtimeAccess("content").authorize({ event, mode: "write" })).resolves.toBe(true)
})
