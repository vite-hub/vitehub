import { describe, expect, it, vi } from "vitest"

import { createShellRuntime } from "../src/index.ts"
import { createJustBashProvider } from "../src/providers/just-bash.ts"
import { createReadonlyWorkspaceFs } from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

function createRuntime() {
  const executeSourceRequest = vi.fn(async () => ({ content: "ok" }))
  const runtime = createShellRuntime({
    provider: createJustBashProvider({
      commands: ["curl"],
      fs: createReadonlyWorkspaceFs(new MemoryWorkspace({})),
      networkGrants: { executeSourceRequest },
    }),
  })
  return { runtime, executeSourceRequest }
}

describe("controlled curl empty bodies", () => {
  it.each(["-d ''", '--data ""', "--data-raw ''", '--data-binary ""', "--data=", "--data-raw=", "--data-binary="])("sends an empty body with %s", async (option) => {
    const { runtime, executeSourceRequest } = createRuntime()
    await expect(runtime.exec(`curl ${option} https://example.com/action`)).resolves.toMatchObject({
      event: "command_finished",
      exitCode: 0,
      stdout: "ok",
    })
    expect(executeSourceRequest).toHaveBeenCalledExactlyOnceWith({
      body: "",
      method: "POST",
      url: "https://example.com/action",
    })
  })

  it.each(["-d", "--data", "--data-raw", "--data-binary"])("rejects a missing argument after %s", async (option) => {
    const { runtime, executeSourceRequest } = createRuntime()
    await expect(runtime.exec(`curl https://example.com/action ${option}`)).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("requires a body"),
    })
    expect(executeSourceRequest).not.toHaveBeenCalled()
  })
})
