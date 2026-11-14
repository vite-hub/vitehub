import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

import { describe, expect, it } from "vitest"

import { loadWorkerPhoton } from "../src/runtime/state.ts"

const require = createRequire(import.meta.url)

// This file imports only the `others` entry, which does not initialize Photon on import, like a Worker build.
describe("Photon on a Worker", () => {
  it.each(["Promise of the module, as with wasm.lazy", "compiled module"])("initializes the others entry once from a %s", async (kind) => {
    const others = await import("@cf-wasm/photon/others")
    const compiled = new WebAssembly.Module(await readFile(require.resolve("@cf-wasm/photon/photon.wasm")))
    const wasm = { default: kind === "compiled module" ? compiled : Promise.resolve(compiled) }
    const loads = await Promise.all([1, 2].map(() => loadWorkerPhoton(Promise.resolve(others), Promise.resolve(wasm))))
    expect(loads[0]).toBe(others)
    const image = new others.PhotonImage(new Uint8Array(4 * 4 * 4).fill(255), 4, 4)
    expect(image.get_width()).toBe(4)
    image.free()
  })
})

