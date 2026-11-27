import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { previewVersion, writePreviewManifests } from "../.github/scripts/preview-packages.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const sha = "0123abc".padEnd(40, "0")
const publishedVersion = "0.4.1"
const workspaces: string[] = []

async function workspace(manifests: Record<string, object>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-preview-packages-"))
  workspaces.push(root)
  for (const [directory, manifest] of Object.entries(manifests)) {
    await mkdir(join(root, "packages", directory), { recursive: true })
    await writeFile(join(root, "packages", directory, "package.json"), JSON.stringify(manifest))
  }
  return root
}

async function manifest(root: string, directory: string) {
  return JSON.parse(await readFile(join(root, "packages", directory, "package.json"), "utf8"))
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("preview package manifests", () => {
  it("gives every public package a version that npm does not have", async () => {
    const root = await workspace({
      agent: { name: "@vite-hub/agent", version: "0.1.0" },
      internal: { name: "@vite-hub/internal", private: true, version: "0.0.0" },
    })

    expect(await writePreviewManifests(root, sha, publishedVersion)).toBe("0.0.0-preview-0123abc")
    expect((await manifest(root, "agent")).version).toBe("0.0.0-preview-0123abc")
    expect((await manifest(root, "internal")).version).toBe("0.0.0")
  })

  it("uses the published version for workspace peers and keeps explicit ranges", async () => {
    const root = await workspace({
      agent: { name: "@vite-hub/agent", version: "0.1.0" },
      env: {
        name: "@vite-hub/env",
        peerDependencies: { "@vite-hub/agent": "^0.1.0", "vite": ">=8.0.0" },
        version: "0.1.0",
      },
      kv: { name: "@vite-hub/kv", version: "0.2.0" },
      schedule: {
        dependencies: { "@vite-hub/runtime": "workspace:*" },
        name: "@vite-hub/schedule",
        peerDependencies: { "@vite-hub/agent": "workspace:^", "@vite-hub/env": "*", "@vite-hub/kv": "workspace:*" },
        peerDependenciesMeta: { "@vite-hub/env": { optional: true } },
        version: "0.1.0",
      },
    })

    await writePreviewManifests(root, sha, publishedVersion)

    expect((await manifest(root, "env")).peerDependencies).toEqual({
      "@vite-hub/agent": "^0.1.0 || 0.0.0-preview-0123abc",
      "vite": ">=8.0.0",
    })
    const schedule = await manifest(root, "schedule")
    expect(schedule.peerDependencies).toEqual({
      "@vite-hub/agent": "^0.4.1 || 0.0.0-preview-0123abc",
      "@vite-hub/env": "0.4.1 || 0.0.0-preview-0123abc",
      "@vite-hub/kv": "0.4.1 || 0.0.0-preview-0123abc",
    })
    expect(schedule.peerDependenciesMeta).toEqual({ "@vite-hub/env": { optional: true } })
    expect(schedule.dependencies).toEqual({ "@vite-hub/runtime": "workspace:*" })
  })

  it("rejects a short commit SHA", () => {
    expect(() => previewVersion("0123abc")).toThrow("Expected a full commit SHA")
  })

  it("lets a running main publish finish when main moves", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8")
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}")
  })

  it("runs between the fresh build and the preview publish", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8")
    const build = workflow.indexOf("- run: vp run --no-cache --filter \"./packages/*\" build")
    const registryVersion = workflow.indexOf('published_version="$(npm view vite-hub@latest version --registry=https://registry.npmjs.org)"')
    const prepare = workflow.indexOf('node .github/scripts/preview-packages.mjs "$PREVIEW_SHA" "$published_version"')
    const publish = workflow.indexOf("pkg-pr-new publish")
    expect(build).toBeGreaterThan(-1)
    expect(registryVersion).toBeGreaterThan(build)
    expect(prepare).toBeGreaterThan(registryVersion)
    expect(publish).toBeGreaterThan(prepare)
  })
})
