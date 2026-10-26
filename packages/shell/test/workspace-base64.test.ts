import { Buffer } from "node:buffer"
import { expect, it } from "vitest"

import { createWritableWorkspaceFs } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

it("preserves every byte in large Base64 writes and appends", async () => {
  const bytes = Buffer.alloc(131_073)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
  const encoded = bytes.toString("base64")
  const fs = createWritableWorkspaceFs(new MemoryWorkspace({}))

  await fs.writeFile("/workspace/data.bin", encoded, "base64")
  expect(Buffer.from(await fs.readFileBuffer("/workspace/data.bin")).equals(bytes)).toBe(true)

  await fs.appendFile("/workspace/data.bin", encoded, { encoding: "base64" })
  expect(Buffer.from(await fs.readFileBuffer("/workspace/data.bin")).equals(Buffer.concat([bytes, bytes]))).toBe(true)
})
