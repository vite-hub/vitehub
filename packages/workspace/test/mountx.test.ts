import { createLoopback } from "mountx"
import { describe, expect, it } from "vitest"

import { defineWorkspace } from "../src/core/define.ts"
import { createWorkspace } from "../src/core/workspace.ts"
import { createWorkspaceDriver } from "../src/mountx.ts"

function workspace() {
  return createWorkspace({
    ...defineWorkspace({ store: { provider: "memory" } }),
    name: "mountx",
  })
}

describe("MountX Workspace driver", () => {
  it("projects a transactional Workspace Session through the MountX filesystem contract", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "before", {
      mediaType: "text/markdown",
      metadata: { source: "docs" },
    })
    await docs.writeFile("remove.md", "temporary")
    await docs.writeFile("script.sh", "#!/bin/sh\n", {
      mediaType: "text/x-shellscript",
      metadata: { gitMode: "100755" },
    })
    await docs.snapshot({ name: "baseline" })

    const session = await docs.startSession()
    const fs = createLoopback(createWorkspaceDriver(session))

    expect(new TextDecoder().decode(await fs.readFile("/README.md"))).toBe("before")
    await fs.mkdir("/notes")
    await fs.writeFile("/notes/draft.md", "draft")
    await fs.rename("/notes/draft.md", "/notes/final.md")
    await fs.writeFile("/README.md", "after")
    await fs.rename("/script.sh", "/run.sh")
    await fs.unlink("/remove.md")

    expect((await fs.stat("/run.sh")).mode & 0o111).toBe(0o111)
    await expect(session.readFile("README.md")).resolves.toBe("after")
    await expect(session.readFile("notes/final.md")).resolves.toBe("draft")
    await expect(session.readFile("remove.md")).rejects.toThrow("does not exist")
    await expect(session.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        mediaType: "text/markdown",
        metadata: { source: "docs" },
        path: "README.md",
      }),
      expect.objectContaining({
        mediaType: "text/x-shellscript",
        metadata: { gitMode: "100755" },
        path: "run.sh",
      }),
    ]))
    await expect(docs.exists("notes/final.md")).resolves.toBe(false)

    await session.commit({ message: "accept projected changes" })
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("after")
    await expect(docs.readFile("notes/final.md")).resolves.toBe("draft")
    await expect(docs.exists("remove.md")).resolves.toBe(false)
    await expect(docs.stat("README.md")).resolves.toMatchObject({
      mediaType: "text/markdown",
      metadata: { source: "docs" },
    })
    await expect(docs.stat("run.sh")).resolves.toMatchObject({
      mediaType: "text/x-shellscript",
      metadata: { gitMode: "100755" },
    })
  })

  it("can expose a Workspace Session read-only", async () => {
    const docs = workspace()
    await docs.writeFile("README.md", "readable")

    const session = await docs.startSession()
    const fs = createLoopback(createWorkspaceDriver(session, { readOnly: true }))

    expect(new TextDecoder().decode(await fs.readFile("/README.md"))).toBe("readable")
    await expect(fs.writeFile("/README.md", "blocked")).rejects.toMatchObject({ code: "EROFS" })
    await session.close()
  })

  it("rejects Workspace symlinks instead of projecting them as regular files", async () => {
    const docs = workspace()
    await docs.writeFile("linked.md", "README.md", {
      metadata: { gitMode: "120000" },
    })

    const session = await docs.startSession()
    const fs = createLoopback(createWorkspaceDriver(session))

    await expect(fs.stat("/linked.md")).rejects.toMatchObject({ code: "ENOTSUP" })
    await session.close()
  })

  it("rejects unstorage-incompatible Workspace filenames during enumeration", async () => {
    const docs = workspace()
    await docs.writeFile("report:final.txt", "colon")
    await docs.writeFile("report/final.txt", "directory")

    const session = await docs.startSession()
    const fs = createLoopback(createWorkspaceDriver(session))

    await expect(fs.readdir("/", { withFileTypes: true })).rejects.toMatchObject({ code: "EINVAL" })
    await session.close()
  })
})
