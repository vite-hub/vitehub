import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { object, parse, string } from "valibot"
import { expect, it } from "vitest"

import { syncPackedWorkspaceDependencies } from "../packages/internal/test-utils/published-types.ts"

it.each([undefined, "pnpm@10.30.0"])("pins a tarball consumer's package manager without replacing %s", async (packageManager) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-consumer-config-"))
  const consumer = join(root, "consumer")
  try {
    await mkdir(consumer)
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.0" }))
    await writeFile(join(consumer, "package.json"), JSON.stringify({ packageManager, dependencies: {} }))
    await syncPackedWorkspaceDependencies(consumer, root, [])
    const raw: unknown = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"))
    const manifest = parse(object({ packageManager: string() }), raw)
    expect(manifest.packageManager).toBe(packageManager ?? "pnpm@10.33.0")
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
