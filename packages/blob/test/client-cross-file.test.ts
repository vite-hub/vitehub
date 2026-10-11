import { describe, expect, it, vi } from "vitest"
import { uploadFiles } from "../src/client.ts"
describe("uploadFiles cross-realm inputs", () => {
  it("uploads a File created by another realm", async () => {
    const crossRealmFile = Object.create(null)
    Object.defineProperty(crossRealmFile, Symbol.toStringTag, { value: "File" })
    Object.defineProperties(crossRealmFile, { name: { value: "a.txt" }, size: { value: 1 } })
    const append = vi.fn()
    vi.stubGlobal("FormData", class { append = append })
    const fetch = vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } }))
    await uploadFiles("/api", crossRealmFile as never, { fetch })
    expect(append).toHaveBeenCalledWith("files", crossRealmFile)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
