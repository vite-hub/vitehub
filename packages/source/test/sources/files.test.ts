import { describe, expect, it } from "vitest"

import { createSource } from "../../src/index.ts"
import { files } from "../../src/files.ts"

describe("@vite-hub/source files()", () => {
  it("serves held files by path below base, without a file system", async () => {
    const docs = files({
      "../content/docs/index.md": "# Home\n",
      "../content/docs/guide/setup.md": "# Setup\n",
      "../content/docs/logo.png": new Uint8Array([1, 2]),
    }, { base: "../content/docs" })

    const reader = createSource(docs, { rootDir: "/does-not-exist" })
    await expect(reader.keys()).resolves.toEqual(["guide/setup.md", "index.md", "logo.png"])
    await expect(reader.read("guide/setup.md")).resolves.toBe("# Setup\n")
    await expect(docs.getItem("index.md", { rootDir: "/" })).resolves.toMatchObject({ path: "index.md", mediaType: "text/markdown" })
    await expect(docs.getItem("logo.png", { rootDir: "/" })).resolves.toMatchObject({ mediaType: "image/png", content: new Uint8Array([1, 2]) })
  })

  it("accepts base with a trailing slash or backslashes", async () => {
    await expect(files({ "docs\\a.md": "a" }, { base: "docs/" }).getKeys({ rootDir: "/" })).resolves.toEqual(["a.md"])
  })

  it("rejects paths outside base, unsafe paths, and duplicates", () => {
    expect(() => files({ "../other/a.md": "a" }, { base: "../docs" })).toThrow("does not start with base")
    expect(() => files({ "../a.md": "a" })).toThrow("Source path escapes the source root")
    expect(() => files({ "docs/a.md": "a", "docs\\a.md": "b" }, { base: "docs" })).toThrow("two files")
  })

  it("fails to read a key it does not hold", async () => {
    await expect(files({ "a.md": "a" }).getItem("b.md", { rootDir: "/" })).rejects.toThrow("could not find")
  })
})
