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
    await fs.mkdir("/empty")
    await fs.mkdir("/nested/deep", { recursive: true })
    await fs.writeFile("/notes/draft.md", "draft")
    await fs.writeFile("/nested/deep/file.txt", "nested")
    await fs.rename("/notes/draft.md", "/notes/final.md")
    await fs.rename("/nested", "/moved")
    await fs.writeFile("/README.md", "after")
    await fs.rename("/script.sh", "/run.sh")
    await fs.writeFile("/notes/query?:$", "supported")
    await fs.symlink("final.md", "/notes/latest.md")
    await fs.unlink("/remove.md")

    expect((await fs.stat("/run.sh")).mode & 0o111).toBe(0o111)
    await expect(session.readFile("README.md")).resolves.toBe("after")
    await expect(session.readFile("notes/final.md")).resolves.toBe("draft")
    await expect(session.readFile("notes/query?:$")).resolves.toBe("supported")
    await expect(session.readFile("moved/deep/file.txt")).resolves.toBe("nested")
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
    await expect(session.list("empty")).resolves.toEqual([])
    await expect(session.list("")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "empty", type: "directory" }),
    ]))
    await expect(fs.readlink("/notes/latest.md")).resolves.toBe("final.md")
    await expect(fs.lstat("/notes/latest.md")).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    })
    expect((await fs.lstat("/notes/latest.md")).isSymbolicLink()).toBe(true)
    expect(new TextDecoder().decode(await fs.readFile("/notes/latest.md"))).toBe("draft")
    await expect(fs.statfs("/")).resolves.toMatchObject({
      bavail: expect.any(Number),
      blocks: 1_048_576,
      bsize: 4096,
      files: 1_048_576,
    })
    await expect(docs.exists("notes/final.md")).resolves.toBe(false)

    await session.commit({ message: "accept projected changes" })
    await session.close()

    await expect(docs.readFile("README.md")).resolves.toBe("after")
    await expect(docs.readFile("notes/final.md")).resolves.toBe("draft")
    await expect(docs.readFile("notes/query?:$")).resolves.toBe("supported")
    await expect(docs.readFile("moved/deep/file.txt")).resolves.toBe("nested")
    await expect(docs.stat("notes/latest.md")).resolves.toMatchObject({
      metadata: { gitMode: "120000", symlinkTarget: "final.md" },
    })
    await expect(docs.stat("empty")).resolves.toMatchObject({ type: "directory" })
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

  it("keeps a renamed open file attached to its destination", async () => {
    const docs = workspace()
    const session = await docs.startSession()
    const fs = createLoopback(createWorkspaceDriver(session))
    await fs.writeFile("/draft.md", "before")

    const handle = await fs.open("/draft.md", "r+")
    await fs.rename("/draft.md", "/final.md")
    await handle.write(new TextEncoder().encode("after"), 0, 5, 0)
    await handle.close()

    await expect(session.readFile("draft.md")).rejects.toThrow("does not exist")
    await expect(session.readFile("final.md")).resolves.toBe("aftere")
    await session.close()
  })

  it("keeps an open replaced file isolated from its replacement", async () => {
    const docs = workspace()
    const session = await docs.startSession()
    const fs = createLoopback(createWorkspaceDriver(session))
    await fs.writeFile("/source.md", "source")
    await fs.writeFile("/destination.md", "old")

    const replaced = await fs.open("/destination.md", "r+")
    await fs.rename("/source.md", "/destination.md")
    await replaced.write(new TextEncoder().encode("orphan"), 0, 6, 0)
    await replaced.close()

    expect(new TextDecoder().decode(await fs.readFile("/destination.md"))).toBe("source")
    await session.close()
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

})
