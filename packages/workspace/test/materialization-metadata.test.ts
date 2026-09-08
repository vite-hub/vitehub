import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, vi } from "vitest"

import { sha256 } from "../src/core/path.ts"
import { normalizeWorkspaceSources } from "../src/sources/config.ts"
import { materializeWorkspaceSources, sourceSnapshotMetaKey } from "../src/sources/materialization.ts"
import { createLocalWorkspaceStore } from "../src/storage/local.ts"

it.each([3600, 0])("restores legacy materialization ownership with cache maxAge %i", async (maxAge) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-metadata-migration-"))
  const sidecars = `${root}.vitehub-file-metadata-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`
  try {
    const getItem = vi.fn(async (key: string) => ({ key, content: "original", mediaType: "text/plain" }))
    const definition = {
      name: "legacy-metadata",
      sources: {
        docs: {
          cache: { maxAge },
          mount: { path: "" },
          materialize: "startup" as const,
          async getKeys() { return ["file.txt"] },
          async getMeta() { return { etag: "unchanged" } },
          getItem,
        },
      },
    }
    const store = createLocalWorkspaceStore(root)
    await materializeWorkspaceSources(definition, store)
    expect(getItem).toHaveBeenCalledTimes(1)

    // Reproduce the pre-sidecar snapshot format and its metadata-free files.
    const source = normalizeWorkspaceSources(definition.sources)[0]!
    const configHash = await sha256({
      cache: source.cache, key: source.key, materialize: source.materialize,
      mountPath: source.mountPath, source: source.source.fingerprint,
    })
    const snapshotKey = sourceSnapshotMetaKey(source.key)
    const snapshot = await store.getMeta!(snapshotKey) as Record<string, unknown>
    await store.setMeta!(snapshotKey, {
      ...snapshot, configHash,
      materializedAt: new Date(Date.now() - 1000).toISOString(),
    })
    await rm(sidecars, { recursive: true })

    const restarted = createLocalWorkspaceStore(root)
    await expect(restarted.readFile("file.txt")).resolves.toMatchObject({ metadata: undefined })
    const result = await materializeWorkspaceSources(definition, restarted)
    expect(result.sources[0]?.status).toBe("ready")
    expect(getItem).toHaveBeenCalledTimes(2)
    await expect(createLocalWorkspaceStore(root).readFile("file.txt")).resolves.toMatchObject({
      content: new TextEncoder().encode("original"), mediaType: "text/plain",
      metadata: { source: "docs", sourcePath: "file.txt" },
    })
    await materializeWorkspaceSources(definition, createLocalWorkspaceStore(root))
    expect(getItem).toHaveBeenCalledTimes(2)
  }
  finally {
    await Promise.all([root, sidecars, `${root}.meta.json`, `${root}.vitehub-locks`, `${root}.vitehub-lock`]
      .map(path => rm(path, { recursive: true, force: true })))
  }
})
