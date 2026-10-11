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
