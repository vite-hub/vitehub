import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("@vite-hub/kv", () => { throw new Error("KV is not configured") })

beforeEach(() => vi.resetModules())
afterEach(async () => { (await import("../src/internal/optional-kv.ts")).installAgentKV(undefined) })

function storage() {
  const values = new Map<string, unknown>()
  const module = {
    kv: {
      get: async (key: string) => [null, values.get(key)],
      set: async (key: string, value: unknown) => { values.set(key, value); return [null] },
      delete: async (key: string) => { values.delete(key); return [null] },
    },
  }
  return { values, module }
}

it.each(["replacement", "removal"])("updates connector storage after KV %s, including an already used connector", async (reload) => {
  const { installAgentKV } = await import("../src/internal/optional-kv.ts")
  const { slack } = await import("../src/channels.ts")
  const first = storage()
  const second = storage()
  // SAFETY: The connector uses only get, set and delete from the KV module.
  installAgentKV(first.module as never)
  let sent = 0
  const postMessage = vi.fn(async () => ({ id: String(++sent) }))
  // SAFETY: Sending without a thread uses only postMessage on the Slack adapter.
  const connector = slack({ adapter: { postMessage } as never })
  const options = { recipient: "slack:C123", idempotencyKey: "same-event" }
  await connector.send("First", options)
  expect(first.values.size).toBe(1)

  installAgentKV(reload === "replacement" ? second.module as never : undefined)
  if (reload === "replacement") {
    await expect(connector.send("Second", options)).resolves.toEqual({ id: "2" })
    expect(second.values.size).toBe(1)
    expect(postMessage).toHaveBeenCalledTimes(2)
  }
  else {
    await expect(connector.send("Second", options)).rejects.toThrow("requires @vite-hub/kv to be installed and configured")
    expect(postMessage).toHaveBeenCalledOnce()
  }
})
