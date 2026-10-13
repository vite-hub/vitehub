import { describe, expect, it, vi } from "vitest"

import { resolveDevRuntimeCapabilities } from "../src/vite/invocation-stream-endpoint.ts"

describe("Agent Dev Loop runtime capabilities", () => {
  it("loads configured capability modules concurrently", async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const server = {
      ssrLoadModule: vi.fn(async (specifier: string) => {
        started.push(specifier)
        await gate
        return specifier === "@vite-hub/database/drizzle"
          ? { agentDb: "db" }
          : { blob: "blob" }
      }),
    }

    const capabilities = resolveDevRuntimeCapabilities(server as never, [
      { importName: "agentDb", name: "db", packageName: "@vite-hub/database/drizzle" },
      { importName: "blob", name: "blob", packageName: "@vite-hub/blob" },
    ], { schedule: false })

    await expect.poll(() => started.length).toBe(2)
    release()

    await expect(capabilities).resolves.toEqual({ db: "db", blob: "blob" })
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(2)
  })
})
