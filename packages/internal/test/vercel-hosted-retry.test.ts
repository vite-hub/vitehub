import { describe, expect, it, vi } from "vitest"

import { createVercelHostedServer } from "../src/runtime/vercel-hosted.ts"

// The Node adapter of H3 fails to load once, as an import can fail when a dependency is reinstalled.
const h3Node = vi.hoisted(() => ({ failures: 0 }))

vi.mock("h3/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("h3/node")>()
  return {
    ...actual,
    get toNodeHandler() {
      if (h3Node.failures > 0) {
        h3Node.failures--
        throw new Error("transient h3/node load failure")
      }
      return () => () => "handled"
    },
  }
})

describe("createVercelHostedServer", () => {
  it("loads the Node handler again on the next request after a failed load", async () => {
    h3Node.failures = 1
    const server = createVercelHostedServer({ app: () => new Response("ok"), label: "test" })

    await expect(server({}, {})).rejects.toThrow("transient h3/node load failure")
    await expect(server({}, {})).resolves.toBe("handled")
  })
})
