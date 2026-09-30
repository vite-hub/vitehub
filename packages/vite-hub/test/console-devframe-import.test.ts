import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ initDevframe: vi.fn() }))

vi.mock("devframe/initiate", () => ({ initDevframe: mocks.initDevframe }))

import { createConsoleDevframeHandler } from "../src/console/runtime/server/devframe.ts"

describe("Console Devframe module", () => {
  it("does not initialize Devframe in the host runtime's global scope", () => {
    expect(mocks.initDevframe).not.toHaveBeenCalled()
  })

  it("rejects headerless session requests before initializing Devframe", async () => {
    const handler = createConsoleDevframeHandler()
    try {
      const request = new Request("http://vitehub.local/_vitehub/rpc/__sse")
      // SAFETY: This fixture supplies the request fields read by the ViteHub H3 adapter.
      const response = await handler({ method: request.method, req: request } as never) as Response
      expect(response.status).toBe(403)
      expect(mocks.initDevframe).not.toHaveBeenCalled()
    } finally {
      await handler.close()
    }
  })
})
