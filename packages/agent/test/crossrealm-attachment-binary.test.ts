import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { isArrayBufferValue, isBlobValue, isUint8ArrayValue } from "../src/provider-agent.ts"

describe("provider attachment binary values", () => {
  it("recognizes binary values from another realm", () => {
    const foreign = { blob: runInNewContext("({ [Symbol.toStringTag]: 'Blob', arrayBuffer: async () => new ArrayBuffer(0) })"), buffer: runInNewContext("new ArrayBuffer(2)"), bytes: runInNewContext("new Uint8Array([1, 2])") } as Record<string, unknown>
    expect(isBlobValue(foreign.blob)).toBe(true)
    expect(isArrayBufferValue(foreign.buffer)).toBe(true)
    expect(isUint8ArrayValue(foreign.bytes)).toBe(true)
  })
})
