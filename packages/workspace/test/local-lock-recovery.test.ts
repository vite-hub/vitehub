import { createHash } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { recoverLocalWorkspaceLocks } from "../src/storage/recover-local-locks.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

it("unblocks a local store after offline recovery and preserves its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-lock-recovery-"))
  try {
    const store = createLocalWorkspaceStore(root)
    const path = "repo/test.sql"
    await store.writeFile(path, { path, content: "original", metadata: { owner: "source" } })
    const locks = join(root, ".vitehub/locks")
    const hash = createHash("sha256").update(path).digest("hex")
    await mkdir(join(locks, `${hash}.gate`))
    await writeFile(join(locks, `${hash}.gate/owner`), "terminated owner")
    await mkdir(join(locks, `${hash}.readers`))
    await writeFile(join(locks, `${hash}.readers/reader`), "")
    await writeFile(join(locks, "unrelated"), "keep")
    await expect(store.readFile(path)).rejects.toThrow("Timed out waiting to write Workspace")
    await expect(recoverLocalWorkspaceLocks({ root, offline: true })).resolves.toEqual({
      removed: 2,
    })
    expect(await store.readFile(path)).toMatchObject({ metadata: { owner: "source" } })
    expect(await readFile(join(root, path), "utf8")).toBe("original")
    expect(await readdir(locks)).toEqual(["unrelated"])
    await expect(recoverLocalWorkspaceLocks({ root, offline: true })).resolves.toEqual({
      removed: 0,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it("refuses symlinked lock directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-lock-symlink-"))
  try {
    await mkdir(join(root, "outside"))
    await writeFile(join(root, "outside/keep"), "keep")
    await symlink(join(root, "outside"), join(root, ".vitehub"))
    await expect(recoverLocalWorkspaceLocks({ root, offline: true })).rejects.toThrow(
      "Untrusted Workspace",
    )
    expect(await readFile(join(root, "outside/keep"), "utf8")).toBe("keep")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
