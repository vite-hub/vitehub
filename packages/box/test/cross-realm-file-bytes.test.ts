import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveBox, type BoxRuntime } from "../src/index.ts"

async function resolveFile(contents: unknown) {
  let bytes: Uint8Array | undefined
  const runtime: BoxRuntime = {
    name: "test",
    open: async () => { throw new Error("not used") },
    prepare: async input => {
      bytes = await input.plan.files["payload.bin"]!.resolve()
      return {
        cache: { state: "disposable" },
        environment: { env: {} },
        executionAuthority: {
          credentials: "none",
          environment: "none",
          filesystem: { access: "none", scope: "none" },
          isolation: "none",
          network: "none",
          processes: "none",
        },
        identity: "test",
        requirements: [],
        runtime: "test",
        workspace: { state: "disposable" },
      }
    },
  }
  await resolveBox({ home: { files: { "payload.bin": { contents: contents as Uint8Array } } }, runtime }, {})
  return bytes
}

describe("Box file byte boundaries", () => {
  it("preserves a Uint8Array from another realm without reading its display tag", async () => {
    const foreignBytes = runInNewContext("class Bytes extends Uint8Array {}; new Bytes([0, 255, 7])") as Uint8Array
    let tagCalls = 0
    Object.defineProperty(foreignBytes, Symbol.toStringTag, {
      get() { tagCalls++; throw new Error("display tag must not be read") },
    })

    const resolved = await resolveFile(foreignBytes)
    expect(resolved).toBe(foreignBytes)
    expect(Array.from(resolved ?? [])).toEqual([0, 255, 7])
    expect(tagCalls).toBe(0)
  })

  it.each([
    ["local Uint8Array", new Uint8Array([0, 255, 7])],
    ["Node Buffer", Buffer.from([0, 255, 7])],
  ])("preserves %s file bytes", async (_label, bytes) => {
    expect(await resolveFile(bytes)).toBe(bytes)
  })

  it.each([
    ["Uint8ClampedArray", new Uint8ClampedArray([0, 255, 7])],
    ["empty Uint16Array", new Uint16Array(0)],
    ["Uint16Array", new Uint16Array([0xff])],
    ["DataView", new DataView(new ArrayBuffer(3))],
  ])("rejects %s at file materialization", async (_label, view) => {
    await expect(resolveFile(view)).rejects.toMatchObject({ code: "BOX_R0048" })
  })

  it.each([
    ["DataView", new DataView(new ArrayBuffer(3))],
    ["Uint16Array", new Uint16Array([0xff])],
  ])("rejects a spoofed %s at file materialization", async (_label, view) => {
    Object.defineProperty(view, Symbol.toStringTag, { value: "Uint8Array" })
    Object.setPrototypeOf(view, { BYTES_PER_ELEMENT: 1 })
    await expect(resolveFile(view)).rejects.toMatchObject({ code: "BOX_R0048" })
  })
})
