import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

import { createLocalWorkspaceStore } from "../src/storage/local.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-local-paths-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const outside = join(root, "outside")
  await mkdir(workspace)
  await mkdir(outside)
  await writeFile(join(outside, "secret.txt"), "private")
  await symlink(outside, join(workspace, "linked"), "junction")
  return { store: createLocalWorkspaceStore(workspace), workspace, outside }
}

it.each(["read", "stat", "list", "write", "stream", "mkdir", "rm", "rmdir"] as const)("rejects %s through a symbolic-link directory", async (operation) => {
  const { store, outside } = await fixture()
  await mkdir(join(outside, "empty"))
  const path = "linked/secret.txt"
  const action = {
    read: () => store.readFile(path),
    stat: () => store.stat(path),
    list: () => store.list("linked", { recursive: true }),
    write: () => store.writeFile(path, { path, content: "changed" }),
    stream: () => store.writeFileStream!(path, { path, content: (async function* () { yield new TextEncoder().encode("changed") })() }),
    mkdir: () => store.mkdir("linked/created"),
    rm: () => store.rm(path),
    rmdir: () => store.removeEmptyDirectory!("linked/empty"),
  }[operation]
  await expect(action()).rejects.toThrow(/symbolic-link/)
  await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("private")
  await expect(readdir(outside)).resolves.toEqual(["empty", "secret.txt"])
})

it("rejects file aliases to private Workspace metadata", async () => {
  const { store, workspace } = await fixture()
  await mkdir(join(workspace, ".vitehub"))
  await writeFile(join(workspace, ".vitehub", "private.json"), "private")
  await symlink(join(workspace, ".vitehub", "private.json"), join(workspace, "public.txt"))
  await expect(store.readFile("public.txt")).rejects.toThrow(/symbolic-link/)
  await expect(store.stat("public.txt")).rejects.toThrow(/symbolic-link/)
  await expect(store.writeFile("public.txt", { path: "public.txt", content: "private" })).rejects.toThrow(/symbolic-link/)
  await expect(readFile(join(workspace, ".vitehub", "private.json"), "utf8")).resolves.toBe("private")
})

it("unlinks a symbolic-link target without removing its directory contents", async () => {
  const { store, workspace, outside } = await fixture()
  await store.rm("linked", { recursive: true })
  await expect(lstat(join(workspace, "linked"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("private")
})
