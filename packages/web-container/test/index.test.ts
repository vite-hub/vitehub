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
