import { describe, expect, it } from "vitest"

import { resolveSandboxModulePath, writeSandboxDefinitionBundle } from "../src/runtime/execution-files.ts"
import type { SandboxExecutionBox } from "../src/runtime/execution-box.ts"
import { unknownExecutionAuthority } from "@vite-hub/runtime"

function createSandbox() {
  const writes: string[] = []
  const sandbox = {
    executionAuthority: unknownExecutionAuthority,
    id: "test",
    provider: "vercel",
    close: async () => {},
    exec: async () => ({ code: 0, ok: true, stderr: "", stdout: "" }),
    exists: async () => false,
    mkdir: async () => {},
    readFile: async () => "",
    writeFile: async () => {},
    files: {
      exists: async () => false,
      list: async () => [],
      mkdir: async () => {},
      read: async () => null,
      remove: async () => {},
      write: async (path: string) => { writes.push(path) },
    },
  } as unknown as SandboxExecutionBox
  return { sandbox, writes }
}

describe("sandbox execution file paths", () => {
  it("resolves an entry with Windows separators to the path written by the bundle writer", async () => {
    const { sandbox, writes } = createSandbox()
    const bundle = {
      entry: "src\\definition.mjs",
      modules: { "src\\definition.mjs": "export default {}" },
    }

    await writeSandboxDefinitionBundle(sandbox, "/tmp/bundle", bundle)

    expect(writes).toContain("/tmp/bundle/src/definition.mjs")
    expect(resolveSandboxModulePath("/tmp/bundle", bundle.entry)).toBe("/tmp/bundle/src/definition.mjs")
  })
})
