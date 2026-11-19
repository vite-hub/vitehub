import { afterEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({ hosting: undefined as string | undefined }))

vi.mock("#vitehub/kv/config", () => ({
  get hosting() { return fixture.hosting },
  kv: { store: { base: ".vitehub/data/kv", driver: "fs-lite", inferred: true } },
}))
vi.mock("@vite-hub/kv", () => ({ disposeKVStores: async () => {} }))

afterEach(() => {
  vi.restoreAllMocks()
})

async function bootLines(hosting: string | undefined): Promise<string[]> {
  fixture.hosting = hosting
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const { default: kvNitroPlugin } = await import("../src/runtime/nitro-plugin.ts")
  kvNitroPlugin({ hooks: { hook: () => {} } })
  // The plugin reads the KV configuration with a dynamic import and does not return that promise.
  await new Promise(resolve => setTimeout(resolve, 20))
  return info.mock.calls.map(call => String(call[0]))
}

describe("the boot line of an inferred KV store", () => {
  it("prints nothing on Node, where the Durability table names the store", async () => {
    expect(await bootLines("node-server")).toEqual([])
  })

  it("names the store on another host", async () => {
    expect(await bootLines("netlify")).toEqual([expect.stringContaining("KV store \"default\" uses fs-lite in .vitehub/data/kv")])
  })
})
