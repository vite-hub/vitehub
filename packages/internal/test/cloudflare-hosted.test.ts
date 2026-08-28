import { describe, expect, it } from "vitest"

import { createCloudflareHostedWorker } from "../src/runtime/cloudflare-hosted.ts"

describe("Cloudflare hosted Worker adapter", () => {
  it("returns the framework-neutral 404 when no app handler is installed", async () => {
    const worker = createCloudflareHostedWorker({ label: "test" })
    const response = await worker.fetch(
      new Request("https://example.com/missing"),
      {},
      { waitUntil() {} },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("application/json;charset=UTF-8")
    await expect(response.json()).resolves.toEqual({
      message: "Cannot find any route matching [GET] https://example.com/missing",
      status: 404,
    })
  })
})
