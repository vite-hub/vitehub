import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import { uploadFiles } from "../src/client.ts"

type FetchInput = Parameters<typeof fetch>[0]

describe("uploadFiles cross-realm inputs", () => {
  it("uploads a native File with a separate realm's prototype", async () => {
    // Node VM contexts do not provide File. Supply the native constructor to
    // create real File slots, then give the instance an independent VM prototype.
    const file: File = runInNewContext(`
      const file = new File(["hello"], "a.txt", { type: "text/plain" });
      Object.setPrototypeOf(file, Object.create(Blob.prototype,
        Object.getOwnPropertyDescriptors(File.prototype)));
      file;
    `, { File, Blob })
    expect(file).not.toBeInstanceOf(File)
    expect(await file.text()).toBe("hello")
    const fetch = vi.fn(async (_url: FetchInput, init?: RequestInit) => {
      const form = init?.body as FormData
      const entries = form.getAll("files")
      expect(entries).toHaveLength(1)
      const uploaded = entries[0] as File
      expect(uploaded.name).toBe("a.txt")
      expect(uploaded.type).toBe("text/plain")
      expect(await uploaded.text()).toBe("hello")
      return new Response("[]")
    })
    await uploadFiles("/api", file, { fetch })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    { [Symbol.toStringTag]: "File", name: "a.txt", size: 1 },
    Object.create(File.prototype),
    Object.defineProperty(new Blob(["hello"]), Symbol.toStringTag, { value: "File" }),
  ])("does not upload a spoofed File", async (spoof) => {
    const fetch = vi.fn()
    await expect(uploadFiles("/api", spoof as File, { fetch })).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
