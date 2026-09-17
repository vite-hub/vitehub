import { expect, it } from "vitest"
import { defineAgent } from "../src/index.ts"

it("clones SharedArrayBuffer options and preserves shared view storage", () => {
  const buffer = new SharedArrayBuffer(8)
  new Uint8Array(buffer).set([1, 2, 3, 4])
  const preset = defineAgent({
    options: { buffer, bytes: new Uint8Array(buffer, 1, 2) },
    configure: () => defineAgent({ driver: "codex" }),
  })
  expect(preset.options.buffer).not.toBe(buffer)
  expect(preset.options.bytes.buffer).toBe(preset.options.buffer)
  expect([...preset.options.bytes]).toEqual([2, 3])
  preset.options.bytes[0] = 9
  expect(new Uint8Array(buffer)[1]).toBe(2)
})
