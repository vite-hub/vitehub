import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveBox, type BoxRuntimeInput } from "../src/index.ts"

describe("Box file byte boundaries", () => {
  it("accepts a Uint8Array created in another realm", async () => {
    const foreignBytes = runInNewContext("new Uint8Array([0, 255, 7])") as Uint8Array
    let preparedInput: BoxRuntimeInput | undefined
    const runtime = {
      name: "test",
      open: async () => { throw new Error("not used") },
      prepare: async (input: BoxRuntimeInput) => {
        preparedInput = input
        return {
        executionAuthority: {
          credentials: "none",
          environment: "none",
          filesystem: { access: "none", scope: "none" },
          isolation: "none",
          network: "none",
          processes: "none",
        },
        }
      },
    }
    const box = await resolveBox({ home: { files: { "payload.bin": { contents: foreignBytes } } }, runtime }, {})

    const resolved = await preparedInput?.plan.files["payload.bin"]?.resolve()
    expect(Array.from(resolved ?? [])).toEqual([0, 255, 7])
  })
})
