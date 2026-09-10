import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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

it("accepts a missing cache and private cache with npm command links", async () => {
  const { parent, root } = await fixture()
  await expect(assertTrustedBrowserCache(join(parent, "missing"))).resolves.toBeUndefined()
  await symlink("cli", join(root, "command"))
  await expect(assertTrustedBrowserCache(root)).resolves.toBeUndefined()
})

it.each(["parent", "root", "cli"])("rejects a writable %s before trusting the cache", async (part) => {
  const { parent, root } = await fixture()
  await chmod(part === "parent" ? parent : part === "root" ? root : join(root, "cli"), 0o777)
  await expect(assertTrustedBrowserCache(root)).rejects.toThrow("trusted ownership and permissions")
})

it("rejects cache roots and command links pointing outside the cache", async () => {
  const { parent, root } = await fixture()
  const alias = join(parent, "alias")
  await symlink(root, alias)
  await expect(assertTrustedBrowserCache(alias)).rejects.toThrow("trusted ownership and permissions")
  await writeFile(join(parent, "untrusted"), "executable")
  await symlink("../untrusted", join(root, "command"))
  await expect(assertTrustedBrowserCache(root)).rejects.toThrow("trusted ownership and permissions")
})
