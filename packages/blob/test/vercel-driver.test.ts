import { describe, expect, it, vi } from "vitest"

const store = new Map<string, { body: Blob, url: string }>()

vi.mock("@vercel/blob", () => ({
  del: vi.fn(async (url: string) => {
    for (const [pathname, record] of store.entries()) {
      if (record.url === url) store.delete(pathname)
    }
  }),
  head: vi.fn(async (pathname: string) => {
    const record = store.get(pathname)
    return record
      ? {
          contentType: record.body.type,
          pathname,
          size: record.body.size,
          uploadedAt: new Date("2026-04-18T00:00:00.000Z"),
          url: record.url,
        }
      : null
  }),
  list: vi.fn(async () => ({
    blobs: [...store.entries()].map(([pathname, record]) => ({
      contentType: record.body.type,
      pathname,
      size: record.body.size,
      uploadedAt: new Date("2026-04-18T00:00:00.000Z"),
      url: record.url,
    })),
    hasMore: false,
  })),
  put: vi.fn(async (pathname: string, body: string, options: { contentType?: string }) => {
    const blob = new Blob([body], { type: options.contentType })
    const url = `https://blob.example/${pathname}`
    store.set(pathname, { body: blob, url })
    return {
      contentType: blob.type,
      pathname,
      size: blob.size,
      uploadedAt: new Date("2026-04-18T00:00:00.000Z"),
      url,
    }
  }),
}))

describe("createVercelBlobDriver", () => {
  it("writes, lists, heads, reads, and deletes through @vercel/blob", async () => {
    const fetch = vi.fn(async (url: string) => {
      const record = [...store.values()].find(item => item.url === url)
      return {
        arrayBuffer: () => record!.body.arrayBuffer(),
        blob: () => record!.body,
        ok: Boolean(record),
      }
    })
    vi.stubGlobal("fetch", fetch)

    try {
      const { createVercelBlobDriver } = await import("../src/runtime/drivers/vercel-blob.ts")
      const driver = createVercelBlobDriver({
        access: "public",
        driver: "vercel-blob",
        token: "token",
      })

      await driver.put("hello.txt", "hello", { contentType: "text/plain" })
      await expect(driver.head("hello.txt")).resolves.toMatchObject({ pathname: "hello.txt" })
      await expect(driver.get("hello.txt").then(file => file?.text())).resolves.toBe("hello")
      await expect(driver.list()).resolves.toMatchObject({
        blobs: [expect.objectContaining({ pathname: "hello.txt" })],
        hasMore: false,
      })
      await driver.delete("hello.txt")
      await expect(driver.head("hello.txt")).resolves.toBeNull()
    }
    finally {
      vi.unstubAllGlobals()
      store.clear()
    }
  })

  it("rejects private Vercel writes", async () => {
    const { createVercelBlobDriver } = await import("../src/runtime/drivers/vercel-blob.ts")
    const driver = createVercelBlobDriver({
      access: "public",
      driver: "vercel-blob",
    })

    await expect(driver.put("private.txt", "secret", { access: "private" })).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
