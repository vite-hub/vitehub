import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { findViteHubDevServerUrl, readViteHubDevServerFile, removeViteHubDevServerFile, writeViteHubDevServerFile } from "../src/cli.ts"

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { force: true, recursive: true })
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-dev-server-"))
  cleanup.push(root)
  return root
}

describe("dev server file", () => {
  it("is written on listen and removed on close", async () => {
    const root = await project()
    expect(readViteHubDevServerFile(root)).toBeUndefined()
    writeViteHubDevServerFile(root, { root, url: "http://localhost:5199/" })
    expect(readViteHubDevServerFile(root)).toEqual({ root, url: "http://localhost:5199/" })
    removeViteHubDevServerFile(root)
    expect(readViteHubDevServerFile(root)).toBeUndefined()
  })

  it("finds the server of this project, then VITEHUB_DEV_SERVER_URL, and never guesses a port", async () => {
    const root = await project()
    expect(findViteHubDevServerUrl([root], {})).toBeUndefined()
    expect(findViteHubDevServerUrl([root], { VITEHUB_DEV_SERVER_URL: "http://localhost:4000" })).toBe("http://localhost:4000")
    writeViteHubDevServerFile(root, { root, url: "http://localhost:5199/" })
    expect(findViteHubDevServerUrl([root], { VITEHUB_DEV_SERVER_URL: "http://localhost:4000" })).toBe("http://localhost:5199/")
    // A file that names another root belongs to another project.
    writeViteHubDevServerFile(root, { root: "/somewhere/else", url: "http://localhost:5199/" })
    expect(findViteHubDevServerUrl([root], {})).toBeUndefined()
  })

  it("ignores a file that is not valid", async () => {
    const root = await project()
    writeViteHubDevServerFile(root, { root, url: "" })
    expect(readViteHubDevServerFile(root)).toBeUndefined()
  })
})
