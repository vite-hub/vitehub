import { expect, it, vi } from "vitest"

import { checkQueueHandlerResponse } from "../src/internal/handler-response.ts"

it("logs cancellation failure without the rejection in production", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
  const body = new ReadableStream({ cancel: () => Promise.reject(new Error("sensitive cancellation details")) })
  try {
    checkQueueHandlerResponse(new Response(body))
    await vi.waitFor(() => expect(debug).toHaveBeenCalledExactlyOnceWith(
      "[vitehub:queue] The Queue handler response body could not be cancelled.",
    ))
  }
  finally {
    vi.unstubAllEnvs()
    debug.mockRestore()
  }
})
