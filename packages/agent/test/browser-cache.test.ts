import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { assertTrustedBrowserCache } from "../src/internal/browser-cache.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "vh-cache-trust-"))
  roots.push(parent)
  const root = join(parent, "cache")
  await mkdir(root, { mode: 0o700 })
  await writeFile(join(root, "cli"), "executable", { mode: 0o755 })
  return { parent, root }
}

it("claims a missing cache and accepts a private cache with npm command links", async () => {
  const { parent, root } = await fixture()
  await expect(assertTrustedBrowserCache(join(parent, "missing"))).resolves.toBeUndefined()
  const claimed = await lstat(join(parent, "missing"))
  expect(claimed.uid).toBe(process.getuid?.())
  expect(claimed.mode & 0o777).toBe(0o700)
  await expect(mkdir(join(parent, "missing"))).rejects.toMatchObject({ code: "EEXIST" })
  await symlink("cli", join(root, "command"))
  await expect(assertTrustedBrowserCache(root)).resolves.toBeUndefined()
})

it.each(["parent", "root", "cli"])("rejects a writable %s before trusting the cache", async (part) => {
  const { parent, root } = await fixture()
  await chmod(part === "parent" ? parent : part === "root" ? root : join(root, "cli"), 0o777)
  await expect(assertTrustedBrowserCache(root)).rejects.toThrow("trusted ownership and permissions")
})

it("defers mutable content validation until after root reservation", async () => {
  const { root } = await fixture()
  // A lock owner can temporarily leave a broken link while replacing files.
  await symlink("not-yet-published", join(root, "command"))
  await expect(assertTrustedBrowserCache(root, { contents: false })).resolves.toBeUndefined()
  await expect(assertTrustedBrowserCache(root)).rejects.toMatchObject({ code: "ENOENT" })
  await writeFile(join(root, "not-yet-published"), "executable", { mode: 0o700 })
  await expect(assertTrustedBrowserCache(root)).resolves.toBeUndefined()
  await chmod(root, 0o777)
  await expect(assertTrustedBrowserCache(root, { contents: false })).rejects.toThrow("trusted ownership and permissions")
})

it("rejects cache roots and command links pointing outside the cache", async () => {
  const { parent, root } = await fixture()
  const alias = join(parent, "alias")
  await symlink(root, alias)
  await expect(assertTrustedBrowserCache(alias, { contents: false })).rejects.toThrow("trusted ownership and permissions")
  await expect(assertTrustedBrowserCache(alias)).rejects.toThrow("trusted ownership and permissions")
  await writeFile(join(parent, "untrusted"), "executable")
  await symlink("../untrusted", join(root, "command"))
  await expect(assertTrustedBrowserCache(root)).rejects.toThrow("trusted ownership and permissions")
})

it.skipIf(process.getuid?.() !== 0)("prevents another OS user from injecting a command after claiming a missing root", async () => {
  const root = join(tmpdir(), `vh-cache-claim-${crypto.randomUUID()}`)
  roots.push(root)
  await assertTrustedBrowserCache(root)
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", `
    const fs = require('node:fs');
    const root = process.argv[1];
    try { fs.mkdirSync(root); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    try {
      fs.writeFileSync(root + '/command', '#!/bin/sh\\necho injected');
      process.exit(1);
    } catch (error) { if (error.code !== 'EACCES') throw error; }
    try { fs.rmdirSync(root); process.exit(2); }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    process.stdout.write('blocked');
  `, root], { uid: 65534, gid: 65534 })
  expect(stdout).toBe("blocked")
  await expect(lstat(join(root, "command"))).rejects.toMatchObject({ code: "ENOENT" })
})
