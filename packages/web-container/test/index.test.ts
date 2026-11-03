import { describe, expect, it } from "vitest"

import { bootWebContainer, checkWebContainerSupport, toFileSystemTree, WebContainerUnsupportedError } from "../src/index.ts"
import type { WebContainerStatus } from "../src/index.ts"

describe("toFileSystemTree", () => {
  it("nests flat paths into directories", () => {
    expect(toFileSystemTree({ "package.json": "{}", "server/index.js": "a", "./server/lib/util.js": "b" })).toEqual({
      "package.json": { file: { contents: "{}" } },
      server: { directory: {
        "index.js": { file: { contents: "a" } },
        lib: { directory: { "util.js": { file: { contents: "b" } } } },
      } },
    })
  })

  it("rejects paths that leave the root or cross a file", () => {
    expect(() => toFileSystemTree({ "../secret": "x" })).toThrow(/Invalid WebContainer file path/)
    expect(() => toFileSystemTree({ "a": "x", "a/b": "y" })).toThrow(/goes through the file a/)
  })

  it.each(["/etc/passwd", "..", "directory/..", "a/../b", "", ".", "./"])("rejects invalid relative path %j", (path) => {
    expect(() => toFileSystemTree({ [path]: "x" })).toThrow(/Invalid WebContainer file path/)
  })

  it("rejects a file replacing an existing directory", () => {
    expect(() => toFileSystemTree({ "a/b": "nested", "a": "file" })).toThrow(/directory a/)
  })

  it("preserves property names as own file and directory entries", () => {
    const tree = toFileSystemTree(Object.fromEntries([
      ["__proto__", "root"],
      ["nested/__proto__", "nested"],
      ["constructor/toString", "leaf"],
      ["toString/file", "other"],
    ]))
    expect(Object.getPrototypeOf(tree)).toBe(Object.prototype)
    expect(Object.hasOwn(tree, "__proto__")).toBe(true)
    expect(tree.__proto__).toEqual({ file: { contents: "root" } })
    expect(tree.nested).toEqual({ directory: Object.fromEntries([["__proto__", { file: { contents: "nested" } }]]) })
    expect(tree.constructor).toEqual({ directory: { toString: { file: { contents: "leaf" } } } })
    expect(tree.toString).toEqual({ directory: { file: { file: { contents: "other" } } } })
  })
})

describe("bootWebContainer outside an isolated page", () => {
  it("reports unsupported without loading @webcontainer/api", async () => {
    expect(checkWebContainerSupport()).toMatchObject({ supported: false })
    const statuses: WebContainerStatus[] = []
    await expect(bootWebContainer({ onStatus: status => statuses.push(status) })).rejects.toBeInstanceOf(WebContainerUnsupportedError)
    expect(statuses.map(status => status.stage)).toEqual(["checking", "unsupported"])
    expect(statuses.at(-1)?.steps.map(step => [step.stage, typeof step.ms])).toEqual([["checking", "number"], ["unsupported", "number"]])
  })
})
