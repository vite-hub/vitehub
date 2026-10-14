import { describe, expect, it } from "vitest"

import { resolveBox, type BoxRuntime } from "../src/index.ts"

const runtime: BoxRuntime = {
  name: "probe",
  async prepare(input) {
    return {
      cache: { state: "disposable" },
      environment: { env: {} },
      executionAuthority: {
        credentials: "none",
        environment: "selected",
        filesystem: { access: "none", scope: "sandbox" },
        isolation: "container",
        network: "none",
        processes: "none",
      },
      identity: input.identity,
      requirements: input.requirements,
      runtime: "probe",
      workspace: { state: "disposable" },
    }
  },
  async open() {
    throw new Error("unused")
  },
}

describe("Box definition validation", () => {
  it("rejects requirement args that are not arrays", async () => {
    await expect(resolveBox({
      requires: [{ command: "echo", args: "oops" as never }],
      runtime,
    }, {})).rejects.toMatchObject({ code: "BOX_R0059" })
  })

  it("validates a single snapshot of requirement args", async () => {
    let reads = 0
    const requirement = {
      command: "echo",
      get args() {
        reads++
        return reads === 1 ? ["ok"] : "oops"
      },
    }

    await expect(resolveBox({ requires: [requirement as never], runtime }, {})).resolves.toBeDefined()
    expect(reads).toBe(1)
  })
})
