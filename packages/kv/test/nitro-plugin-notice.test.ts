import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveConfig } from "vite"

import { hubKV } from "../src/vite.ts"

const fixture = vi.hoisted(() => ({ durabilityReportsStores: false }))

vi.mock("#vitehub/kv/config", () => ({
  get durabilityReportsStores() { return fixture.durabilityReportsStores },
  kv: { store: { base: ".vitehub/data/kv", driver: "fs-lite", inferred: true } },
}))
vi.mock("@vite-hub/kv", () => ({ disposeKVStores: async () => {} }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function bootLines(durabilityReportsStores: boolean): Promise<string[]> {
  fixture.durabilityReportsStores = durabilityReportsStores
  const info = vi.spyOn(console, "info").mockImplementation(() => {})
  const { default: kvNitroPlugin } = await import("../src/runtime/nitro-plugin.ts")
  kvNitroPlugin({ hooks: { hook: () => {} } })
  await vi.dynamicImportSettled()
  return info.mock.calls.map(call => String(call[0]))
}

describe("the boot line of an inferred KV store", () => {
  it.each([
    ["build", false, false],
    ["build", true, true],
    ["serve", true, false],
  ] as const)("generates the Durability flag for %s (registered: %s)", async (command, registered, reportsStores) => {
    vi.stubEnv("NITRO_PRESET", "node-server")
    const kv = hubKV()
    await resolveConfig({ configFile: false, plugins: [kv, ...(registered ? [{ name: "vite-hub/durability/nitro" }] : [])] }, command)
    expect(kv.api.getConfig().hosting).toBe("node-server")
    const load = typeof kv.load === "object" ? kv.load.handler : kv.load
    expect(load && Reflect.apply(load, {}, ["\0#vitehub/kv/config"])).toContain(`export const durabilityReportsStores = ${reportsStores};`)
  })

  it("prints nothing when the Durability table names the store", async () => {
    expect(await bootLines(true)).toEqual([])
  })

  it("names the store without a Durability table", async () => {
    expect(await bootLines(false)).toEqual([expect.stringContaining("KV store \"default\" uses fs-lite in .vitehub/data/kv")])
  })
})
