import { describe, expect, it } from "vitest"

import { createLocalHarnessSandbox } from "../src/harness/local-sandbox.ts"

describe("local harness sandbox", () => {
  it("runs commands and reads written files", async () => {
    const provider = createLocalHarnessSandbox({ env: { PATH: process.env.PATH } })
    const session = await provider.createSession()

    try {
      await session.writeTextFile({ content: "hello", path: "input.txt" })

      const result = await session.run({ command: "cat input.txt" })

      expect(result).toMatchObject({ exitCode: 0, stdout: "hello" })
      await expect(session.getPortUrl({ port: 4000, protocol: "ws" })).resolves.toBe("ws://127.0.0.1:4000")
    }
    finally {
      await session.destroy?.()
    }
  })
})
