import { runInNewContext } from "node:vm"
import { expect, it, vi } from "vitest"

import { encodeSandboxValue } from "../src/runtime/binary-sidecars.ts"

it("encodes Uint8Array values created in another realm", async () => {
  const bytes = runInNewContext("new Uint8Array([1, 2, 3])") as Uint8Array
  const sandbox = { files: { mkdir: vi.fn(async () => {}), write: vi.fn(async () => {}) } }

  await expect(encodeSandboxValue(sandbox as never, bytes, "/assets", "payload")).resolves.toMatchObject({
    "vitehub:sandbox:value": { kind: "uint8array", tag: "binary" },
  })
  expect(sandbox.files.write).toHaveBeenCalledWith("/assets/0", bytes, { signal: undefined })
})

it("encodes boxed primitives created in another realm", async () => {
  const sandbox = { files: { mkdir: vi.fn(async () => {}), write: vi.fn(async () => {}) } }

  await expect(encodeSandboxValue(sandbox as never, {
    bool: runInNewContext("new Boolean(true)"),
    number: runInNewContext("new Number(7)"),
    string: runInNewContext("new String('ready')"),
    bigint: runInNewContext("Object(9n)"),
  }, "/assets", "payload")).resolves.toEqual({ bool: true, number: 7, string: "ready", bigint: 9n })
})

it.each([
  ["subclass tag", "new (class extends Uint8Array { get [Symbol.toStringTag]() { return 'Bytes' } })([0, 1, 2, 3, 4]).subarray(1, 4)"],
  ["own tag", "Object.defineProperty(new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4), Symbol.toStringTag, { value: 'Bytes' })"],
  ["throwing tag", "Object.defineProperty(new Uint8Array([0, 1, 2, 3, 4]).subarray(1, 4), Symbol.toStringTag, { get() { throw new Error('tag read') } })"],
])("encodes foreign byte arrays with a %s", async (_label, expression) => {
  const bytes = runInNewContext(expression) as Uint8Array
  const sandbox = { files: { mkdir: vi.fn(async () => {}), write: vi.fn(async (_path: string, _bytes: Uint8Array, _options: { signal?: AbortSignal }) => {}) } }

  await expect(encodeSandboxValue(sandbox as never, bytes, "/assets", "payload")).resolves.toEqual({
    "vitehub:sandbox:value": { id: 0, kind: "uint8array", tag: "binary" },
  })
  expect(Array.from(bytes)).toEqual([1, 2, 3])
  expect(sandbox.files.write).toHaveBeenCalledOnce()
  expect(sandbox.files.write.mock.calls[0]?.[0]).toBe("/assets/0")
  expect(sandbox.files.write.mock.calls[0]?.[1]).toBe(bytes)
  expect(sandbox.files.write.mock.calls[0]?.[2]).toEqual({ signal: undefined })
})

it("does not encode another typed array with a Uint8Array tag as a byte sidecar", async () => {
  const value = runInNewContext("Object.defineProperty(new Uint16Array([1, 2, 3]), Symbol.toStringTag, { value: 'Uint8Array' })")
  const sandbox = { files: { mkdir: vi.fn(async () => {}), write: vi.fn(async () => {}) } }

  await expect(encodeSandboxValue(sandbox as never, value, "/assets", "payload"))
    .resolves.toEqual({ 0: 1, 1: 2, 2: 3 })
  expect(sandbox.files.write).not.toHaveBeenCalled()
})
