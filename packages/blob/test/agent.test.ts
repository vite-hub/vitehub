import { describe, expect, it, vi } from "vitest"

import { createBlobTools } from "../src/agent.ts"

describe("createBlobTools", () => {
  it("gates tools by access level without exposing bulk delete", () => {
    expect(Object.keys(createBlobTools({ access: "read", blob: {} as never })).sort()).toEqual([
      "blob_get_text",
      "blob_head",
      "blob_list",
    ])
    expect(Object.keys(createBlobTools({ access: "write", blob: {} as never })).sort()).toEqual([
      "blob_delete",
      "blob_get_text",
      "blob_head",
      "blob_list",
      "blob_put_json",
      "blob_put_text",
    ])
    expect(createBlobTools({ access: "write", blob: {} as never })).not.toHaveProperty("blob_delete_many")
  })

  it("calls the Blob runtime handle for read and text/json writes", async () => {
    const blob = {
      del: vi.fn(async () => {}),
      get: vi.fn(async () => new Blob(["hello"], { type: "text/plain" })),
      head: vi.fn(async () => ({ pathname: "notes/hello.txt" })),
      list: vi.fn(async () => ({ blobs: [], hasMore: false })),
      put: vi.fn(async (pathname: string) => ({ pathname })),
    }
    const tools = createBlobTools({ access: "write", blob })

    await expect(tools.blob_list.execute?.({ prefix: "notes/" })).resolves.toEqual({ blobs: [], hasMore: false })
    await expect(tools.blob_head.execute?.({ pathname: "notes/hello.txt" })).resolves.toEqual({ pathname: "notes/hello.txt" })
    await expect(tools.blob_get_text.execute?.({ pathname: "notes/hello.txt" })).resolves.toEqual({ content: "hello", pathname: "notes/hello.txt" })
    await expect(tools.blob_put_text.execute?.({ content: "hello", pathname: "notes/hello.txt" })).resolves.toEqual({ pathname: "notes/hello.txt" })
    await expect(tools.blob_put_json.execute?.({ content: { ok: true }, pathname: "notes/data.json" })).resolves.toEqual({ pathname: "notes/data.json" })
    await expect(tools.blob_delete.execute?.({ pathname: "notes/hello.txt" })).resolves.toEqual({ pathname: "notes/hello.txt" })

    expect(blob.put).toHaveBeenCalledWith("notes/hello.txt", "hello", {
      contentType: "text/plain; charset=utf-8",
      customMetadata: undefined,
      prefix: undefined,
    })
    expect(blob.put).toHaveBeenCalledWith("notes/data.json", "{\"ok\":true}", {
      contentType: "application/json; charset=utf-8",
      customMetadata: undefined,
      prefix: undefined,
    })
    expect(blob.del).toHaveBeenCalledWith("notes/hello.txt")
  })
})
