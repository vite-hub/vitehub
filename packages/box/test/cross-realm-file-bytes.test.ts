import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveBox, type BoxRuntime, type BoxRuntimeInput } from "../src/index.ts"

describe("Box file byte boundaries", () => {
  it("accepts a Uint8Array created in another realm", async () => {
    const foreignBytes = runInNewContext("class Bytes extends Uint8Array {}; new Bytes([0, 255, 7])") as Uint8Array
    let preparedInput: BoxRuntimeInput | undefined
    const runtime: BoxRuntime = {
      name: "test",
      open: async () => { throw new Error("not used") },
      prepare: async (input: BoxRuntimeInput) => {
        preparedInput = input
        return {
          cache: { state: "disposable" as const },
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
    const box = await resolveBox({ home: { files: { "payload.bin": { contents: foreignBytes } } }, runtime }, {})

    const resolved = await preparedInput?.plan.files["payload.bin"]?.resolve()
    expect(Array.from(resolved ?? [])).toEqual([0, 255, 7])
  })

  it.each([
    [new DataView(new ArrayBuffer(3)), "DataView"],
    [new Uint16Array([0xff]), "non-byte typed array"],
  ])("rejects a spoofed %s", async (view, _label) => {
    Object.defineProperty(view, Symbol.toStringTag, { value: "Uint8Array" })
    Object.setPrototypeOf(view, { BYTES_PER_ELEMENT: 1 })
    const runtime: BoxRuntime = {
      name: "test",
      open: async () => { throw new Error("not used") },
      prepare: async () => ({
        cache: { state: "disposable" as const },
        environment: { env: {} },
        executionAuthority: {
          credentials: "none" as const,
          environment: "none" as const,
          filesystem: { access: "none" as const, scope: "none" as const },
          isolation: "none" as const,
          network: "none" as const,
          processes: "none" as const,
        },
        identity: "test",
        requirements: [],
        runtime: "test",
        workspace: { state: "disposable" as const },
      }),
    }

    await expect(resolveBox({ home: { files: { "payload.bin": { contents: view as unknown as Uint8Array } } }, runtime }, {}))
      .rejects.toMatchObject({ code: "BOX_R0048" })
  })
})
