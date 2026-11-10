import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { consoleRuntimeDigestFile, digestConsoleRuntime } from "../src/console/runtime-digest.ts"

it("digests runtime files and Console client names, but not the client contents or the digest file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-digest-"))
  try {
    await mkdir(join(root, "server"), { recursive: true })
    await mkdir(join(root, "public/console"), { recursive: true })
    await writeFile(join(root, "server/page.get.js"), "export default 1\n")
    await writeFile(join(root, "public/console/console-abc.js"), "client\n")
    const digest = digestConsoleRuntime(root)

    await writeFile(join(root, consoleRuntimeDigestFile), `${digest}\n`)
    await writeFile(join(root, "public/console/console-abc.js"), "same name, other client\n")
    expect(digestConsoleRuntime(root)).toBe(digest)

    await writeFile(join(root, "public/console/console-def.js"), "client\n")
    expect(digestConsoleRuntime(root)).not.toBe(digest)
    await rm(join(root, "public/console/console-def.js"))
    await writeFile(join(root, "server/page.get.js"), "export default 2\n")
    expect(digestConsoleRuntime(root)).not.toBe(digest)
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
